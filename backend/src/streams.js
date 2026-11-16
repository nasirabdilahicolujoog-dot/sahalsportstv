import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { transaction } from './db.js';
import { encrypt, decrypt, sha256 } from './security.js';
import { HttpError, fail } from './errors.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MANIFEST_LIMIT = 1024 * 1024;
const BINARY_LIMIT = 32 * 1024 * 1024;
const MAX_LINKS = 2000;
const MAX_RESOURCES = 20000;
const REQUEST_MS = 20000;
const MIME = { hls: 'application/vnd.apple.mpegurl', dash: 'application/dash+xml' };
const resourceContext = (playbackId, resourceId) => `playback:${playbackId}:resource:${resourceId}`;
const resourcePath = (playbackId, resourceId) => `/v1/streams/${playbackId}/${resourceId}`;
const unsupported = () => fail(422, 'unsupported_manifest', 'The stream manifest uses an unsupported or unsafe format.');
const upstreamError = () => new HttpError(502, 'stream_unavailable', 'The licensed stream is unavailable.');

// Synchronous validation for channel administration. Returns a canonical URL string.
// DNS authorization is deliberately separate and is repeated for every connection/redirect.
export function validateStreamUrl(value, config) {
  const invalid = () => fail(400, 'invalid_stream_url', 'An approved HTTPS stream hostname is required.');
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) invalid();
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || !/^[a-z0-9.-]+(?::443)?$/i.test(authority)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#') ||
      (url.port && url.port !== '443') || isIP(host) || ipaddr.isValid(host) ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|home|test|invalid)$/.test(host) ||
      !config?.streamHosts?.has(host)) invalid();
  return url.href;
}

function publicAddress(address, family) {
  if (typeof address !== 'string' || isIP(address) !== family || ![4, 6].includes(family)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  // Exclude IPv4-mapped, transition, unique-local, link-local and special IPv6 space.
  return family !== 6 || parsed.match(ipaddr.parse('2000::'), 3);
}

async function pinnedLookup(url, lookup, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason || upstreamError());
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  let addresses;
  try {
    addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), cancelled]);
  } finally { signal.removeEventListener('abort', abort); }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 32 ||
      addresses.some(a => !publicAddress(a.address, a.family))) throw upstreamError();
  const selected = addresses[0];
  return (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (host !== url.hostname) return callback(upstreamError());
    // Even with Node's all-address/Happy Eyeballs lookup, only the checked address is returned.
    callback(null, options?.all ? [selected] : selected.address, selected.family);
  };
}

const manifestType = headers => /(?:mpegurl|dash\+xml)/i.test(String(headers['content-type'] || ''));
const manifestPath = url => /\.(?:m3u8?|mpd)$/i.test(new URL(url).pathname);
function manifestBody(body) {
  const prefix = body.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return prefix.startsWith('#EXTM3U') || /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<MPD(?:\s|>)/.test(prefix);
}

function readHop(url, options, request, signal, expectedManifest) {
  return new Promise((resolve, reject) => {
    let response;
    let settled = false;
    let outgoing;
    const abort = () => finish(signal.reason || upstreamError());
    function finish(error, result) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { response?.destroy(); outgoing?.destroy(); reject(error); }
      else resolve(result);
    }
    if (signal.aborted) return reject(signal.reason || upstreamError());
    signal.addEventListener('abort', abort, { once: true });
    try {
      outgoing = request(url, options, incoming => {
        response = incoming;
        incoming.on('error', () => finish(upstreamError()));
        incoming.on('aborted', () => finish(upstreamError()));
        const status = incoming.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = incoming.headers.location;
          finish(null, { status, location });
          incoming.destroy();
          return;
        }
        if (![200, 206].includes(status) || (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity')) {
          finish(upstreamError());
          return;
        }
        let limit = expectedManifest || manifestType(incoming.headers) ? MANIFEST_LIMIT : BINARY_LIMIT;
        const length = incoming.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > limit)) {
          finish(upstreamError());
          return;
        }
        const chunks = [];
        let size = 0;
        let prefix = Buffer.alloc(0);
        incoming.on('data', chunk => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (prefix.length < 4096) {
            prefix = Buffer.concat([prefix, data.subarray(0, 4096 - prefix.length)]);
            if (manifestBody(prefix)) limit = MANIFEST_LIMIT;
          }
          if (size > limit) { finish(upstreamError()); return; }
          chunks.push(data);
        });
        incoming.on('end', () => {
          if (length !== undefined && Number(length) !== size) { finish(upstreamError()); return; }
          finish(null, { status, headers: incoming.headers, body: Buffer.concat(chunks), url: url.href });
        });
      });
      outgoing.on('error', () => finish(upstreamError()));
      outgoing.end();
    } catch { finish(upstreamError()); }
  });
}

async function fetchUpstream(value, config, hooks, range, expectedManifest, signal) {
  let current = value;
  for (let redirects = 0; redirects <= 4; redirects++) {
    let url;
    try { url = new URL(validateStreamUrl(current, config)); } catch { throw upstreamError(); }
    let lookup;
    try { lookup = await pinnedLookup(url, hooks.lookup, signal); }
    catch (error) { throw error instanceof HttpError ? error : upstreamError(); }
    const headers = { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'SahalLicensedStreamProxy/1.0' };
    if (range && !expectedManifest && !manifestPath(url.href)) headers.Range = range;
    const result = await readHop(url, {
      method: 'GET', headers, lookup, agent: false, servername: url.hostname,
      rejectUnauthorized: true, autoSelectFamily: false, maxHeaderSize: 16384,
    }, hooks.request, signal, expectedManifest || manifestPath(url.href));
    if (result.location !== undefined && redirects < 4) {
      if (typeof result.location !== 'string' || result.location.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(result.location)) throw upstreamError();
      try { current = new URL(result.location, url).href; } catch { throw upstreamError(); }
      continue;
    }
    if (!result.body) throw upstreamError();
    return result;
  }
  throw upstreamError();
}

function resolveReference(value, base, config) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\\\u0000-\u001f\u007f]/u.test(value) || value.includes('{$')) unsupported();
  try { return validateStreamUrl(new URL(value, base).href, config); } catch { unsupported(); }
}

function linkCollector() {
  const links = [];
  return {
    links,
    add(target, kind, tail = '') {
      if (links.length >= MAX_LINKS) unsupported();
      const link = { target, kind, tail };
      links.push(link);
      return link;
    },
  };
}

const HLS_SCALARS = new Set([
  '#EXTM3U', '#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-ENDLIST', '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-I-FRAMES-ONLY', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-DISCONTINUITY',
  '#EXT-X-GAP', '#EXT-X-PROGRAM-DATE-TIME', '#EXT-X-BYTERANGE', '#EXT-X-BITRATE',
]);
const HLS_ATTRIBUTES = {
  '#EXT-X-STREAM-INF': 'BANDWIDTH AVERAGE-BANDWIDTH CODECS RESOLUTION FRAME-RATE HDCP-LEVEL AUDIO VIDEO SUBTITLES CLOSED-CAPTIONS VIDEO-RANGE SCORE ALLOWED-CPC REQ-VIDEO-LAYOUT STABLE-VARIANT-ID',
  '#EXT-X-MEDIA': 'TYPE URI GROUP-ID LANGUAGE ASSOC-LANGUAGE NAME DEFAULT AUTOSELECT FORCED INSTREAM-ID CHARACTERISTICS CHANNELS STABLE-RENDITION-ID',
  '#EXT-X-I-FRAME-STREAM-INF': 'URI BANDWIDTH AVERAGE-BANDWIDTH CODECS RESOLUTION HDCP-LEVEL VIDEO VIDEO-RANGE STABLE-VARIANT-ID',
  '#EXT-X-IMAGE-STREAM-INF': 'URI BANDWIDTH AVERAGE-BANDWIDTH CODECS RESOLUTION',
  '#EXT-X-KEY': 'METHOD URI IV KEYFORMAT KEYFORMATVERSIONS',
  '#EXT-X-SESSION-KEY': 'METHOD URI IV KEYFORMAT KEYFORMATVERSIONS',
  '#EXT-X-MAP': 'URI BYTERANGE',
  '#EXT-X-START': 'TIME-OFFSET PRECISE',
};

function hlsAttributes(value) {
  const attrs = [];
  const seen = new Set();
  let rest = value;
  while (rest) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\s"]+))(,|$)/.exec(rest);
    if (!match || seen.has(match[1])) unsupported();
    seen.add(match[1]);
    attrs.push({ name: match[1], value: match[2] ?? match[3], quoted: match[2] !== undefined });
    rest = rest.slice(match[0].length);
    if (match[4] && !rest) unsupported();
  }
  if (!attrs.length) unsupported();
  return attrs;
}

function rewriteHls(body, base, config) {
  const text = body.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.startsWith('#EXTM3U') || text.includes('\uFFFD') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) unsupported();
  const input = text.split(/\r?\n/);
  if (input[0].trim() !== '#EXTM3U' || input.length > 20000) unsupported();
  const collector = linkCollector();
  const output = [];
  let variant = false;
  for (let index = 0; index < input.length; index++) {
    const line = input[index].trim();
    if (line.length > 16384) unsupported();
    if (!line) { output.push(''); continue; }
    if (!line.startsWith('#')) {
      const target = resolveReference(line, base, config);
      output.push(collector.add(target, variant || manifestPath(target) ? 'manifest' : 'binary'));
      variant = false;
      continue;
    }
    if (!line.startsWith('#EXT')) continue; // Do not reflect upstream comments/URLs.
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    if (tag === '#EXTM3U' && index !== 0) unsupported();
    if (tag === '#EXTINF') {
      const duration = /^([0-9]+(?:\.[0-9]+)?),/.exec(value)?.[1];
      if (!duration) unsupported();
      output.push(`#EXTINF:${duration},`); // Titles are not required for playback.
    } else if (HLS_SCALARS.has(tag)) {
      if (/:\/\/|\/\/|[<>"{}]/.test(value)) unsupported();
      output.push(line);
    } else if (HLS_ATTRIBUTES[tag]) {
      const attributes = hlsAttributes(value);
      const allowed = new Set(HLS_ATTRIBUTES[tag].split(' '));
      if (attributes.some(a => !allowed.has(a.name))) unsupported();
      const uri = attributes.find(a => a.name === 'URI');
      if (['#EXT-X-KEY', '#EXT-X-SESSION-KEY'].includes(tag)) {
        const method = attributes.find(a => a.name === 'METHOD')?.value;
        const format = attributes.find(a => a.name === 'KEYFORMAT')?.value;
        if (!['NONE', 'AES-128'].includes(method) || (format && format !== 'identity') || (method !== 'NONE' && !uri)) unsupported();
      }
      if (['#EXT-X-MAP', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-IMAGE-STREAM-INF'].includes(tag) && !uri) unsupported();
      for (const attribute of attributes) {
        if (attribute.name === 'URI') {
          if (!attribute.quoted) unsupported();
          const kind = ['#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-IMAGE-STREAM-INF'].includes(tag) ? 'manifest' : 'binary';
          attribute.value = collector.add(resolveReference(attribute.value, base, config), kind);
        } else if (/:\/\/|\/\/|[<>\u0000-\u001f]|\{\$/.test(attribute.value)) unsupported();
      }
      if (tag === '#EXT-X-STREAM-INF') {
        if (variant) unsupported();
        variant = true;
      }
      output.push({ tag, attributes });
    } else unsupported(); // Includes variable substitution, content steering, DRM and LL-HLS.
  }
  if (variant) unsupported();
  return {
    links: collector.links,
    render: path => `${output.map(line => {
      if (typeof line === 'string') return line;
      if (line.target) return path(line);
      return `${line.tag}:${line.attributes.map(a => `${a.name}=${a.quoted ? '"' : ''}${typeof a.value === 'string' ? a.value : path(a.value)}${a.quoted ? '"' : ''}`).join(',')}`;
    }).join('\n')}\n`,
  };
}

// A deliberately restricted XML grammar: no DTD/entities, XLink, XML base, remote
// clock/license/location elements, SegmentBase or SegmentList. Unsupported input
// is rejected instead of being passed through to Media3 unproxied.
const DASH_ATTRIBUTES = {
  MPD: 'id type profiles minBufferTime mediaPresentationDuration availabilityStartTime availabilityEndTime publishTime minimumUpdatePeriod timeShiftBufferDepth suggestedPresentationDelay maxSegmentDuration maxSubsegmentDuration',
  Period: 'id start duration bitstreamSwitching',
  AdaptationSet: 'id group lang contentType mimeType codecs width height frameRate audioSamplingRate segmentAlignment subsegmentAlignment startWithSAP subsegmentStartsWithSAP bitstreamSwitching minBandwidth maxBandwidth minWidth maxWidth minHeight maxHeight minFrameRate maxFrameRate par',
  Representation: 'id bandwidth qualityRanking dependencyId mimeType codecs width height frameRate audioSamplingRate sar startWithSAP scanType',
  BaseURL: '',
  SegmentTemplate: 'media initialization timescale duration startNumber presentationTimeOffset',
  SegmentTimeline: '',
  S: 't d r',
  AudioChannelConfiguration: 'schemeIdUri value',
  Role: 'schemeIdUri value',
};
const DASH_CHILDREN = {
  MPD: ['Period', 'BaseURL'],
  Period: ['AdaptationSet', 'BaseURL', 'SegmentTemplate'],
  AdaptationSet: ['Representation', 'BaseURL', 'SegmentTemplate', 'AudioChannelConfiguration', 'Role'],
  Representation: ['BaseURL', 'SegmentTemplate', 'AudioChannelConfiguration'],
  SegmentTemplate: ['SegmentTimeline'], SegmentTimeline: ['S'],
  BaseURL: [], S: [], AudioChannelConfiguration: [], Role: [],
};
function xmlDecode(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) unsupported();
  return value.replace(/&([^;]+);/g, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity]) return named[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0x7f) unsupported();
    return String.fromCodePoint(code);
  });
}
const xmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function parseDash(body) {
  const text = body.toString('utf8').replace(/^\uFEFF/, '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uFFFD]/u.test(text)) unsupported();
  const stack = [];
  let root;
  let nodes = 0;
  let position = 0;
  while (position < text.length) {
    if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4);
      if (end < 0 || text.slice(position + 4, end).includes('--')) unsupported();
      position = end + 3;
      continue;
    }
    if (text.startsWith('<?xml ', position) && !root && !text.slice(0, position).trim()) {
      const end = text.indexOf('?>', position);
      if (end < 0 || !/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>$/i.test(text.slice(position, end + 2))) unsupported();
      position = end + 2;
      continue;
    }
    if (text[position] !== '<') {
      const end = text.indexOf('<', position);
      const content = xmlDecode(text.slice(position, end < 0 ? text.length : end));
      const parent = stack.at(-1);
      if (content.trim() && parent?.name !== 'BaseURL') unsupported();
      if (parent) parent.text += content;
      position = end < 0 ? text.length : end;
      continue;
    }
    const end = text.indexOf('>', position);
    if (end < 0) unsupported();
    const token = text.slice(position, end + 1);
    position = end + 1;
    if (token.startsWith('</')) {
      const match = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token);
      if (!match || stack.pop()?.name !== match[1]) unsupported();
      continue;
    }
    const match = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!match || !Object.hasOwn(DASH_ATTRIBUTES, match[1]) || ++nodes > 12000 || stack.length > 16) unsupported();
    const node = { name: match[1], attrs: {}, children: [], text: '' };
    let attrs = match[2];
    const allowed = new Set(DASH_ATTRIBUTES[node.name].split(' '));
    const seen = new Set();
    while (attrs.trim()) {
      const attr = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(attrs);
      if (!attr || seen.has(attr[1])) unsupported();
      seen.add(attr[1]);
      attrs = attrs.slice(attr[0].length);
      const name = attr[1];
      const value = xmlDecode(attr[2] ?? attr[3]);
      if (node.name === 'MPD' && name === 'xmlns' && value === 'urn:mpeg:dash:schema:mpd:2011') continue;
      if (node.name === 'MPD' && name === 'xmlns:xsi' && value === 'http://www.w3.org/2001/XMLSchema-instance') continue;
      if (node.name === 'MPD' && name === 'xsi:schemaLocation') continue; // Never emit schema URLs.
      if (!allowed.has(name)) unsupported();
      if (!['media', 'initialization'].includes(name) && /:\/\/|\/\/|[<>]/.test(value)) unsupported();
      node.attrs[name] = value;
    }
    const parent = stack.at(-1);
    if (parent) {
      if (!DASH_CHILDREN[parent.name].includes(node.name)) unsupported();
      parent.children.push(node);
    } else {
      if (root || node.name !== 'MPD') unsupported();
      root = node;
    }
    if (!match[3]) stack.push(node);
  }
  if (!root || stack.length || !root.children.some(c => c.name === 'Period')) unsupported();
  if (root.attrs.type && !['static', 'dynamic'].includes(root.attrs.type)) unsupported();
  root.attrs.xmlns = 'urn:mpeg:dash:schema:mpd:2011';
  return root;
}

function templateTokens(value) {
  const tokens = [...value.matchAll(/\$(Number|Time)(?:%0([1-9]|1[0-2])d)?\$/g)];
  if (tokens.length > 8 || value.replace(/\$(Number|Time)(?:%0([1-9]|1[0-2])d)?\$/g, '').includes('$')) unsupported();
  return tokens;
}

function rewriteDash(body, base, config) {
  const root = parseDash(body);
  const collector = linkCollector();
  let representations = 0;
  function walk(node, inheritedBase, inheritedTemplate) {
    const bases = node.children.filter(c => c.name === 'BaseURL');
    const templates = node.children.filter(c => c.name === 'SegmentTemplate');
    if (bases.length > 1 || templates.length > 1) unsupported();
    const localBase = bases.length ? resolveReference(bases[0].text.trim(), inheritedBase, config) : inheritedBase;
    let template = inheritedTemplate;
    if (templates.length) {
      const local = templates[0];
      if (local.children.length > 1) unsupported();
      template = { attrs: { ...inheritedTemplate?.attrs, ...local.attrs }, children: local.children.length ? local.children : (inheritedTemplate?.children || []) };
    }
    node.children = node.children.filter(c => !['BaseURL', 'SegmentTemplate'].includes(c.name));
    if (node.name === 'Representation') {
      if (++representations > 256 || !template?.attrs.media || !template.attrs.initialization ||
          (!template.attrs.duration && !template.children.length)) unsupported();
      const attrs = { ...template.attrs };
      for (const name of ['timescale', 'duration', 'startNumber', 'presentationTimeOffset']) {
        if (attrs[name] !== undefined && !/^\d{1,20}$/.test(attrs[name])) unsupported();
      }
      if (attrs.timescale === '0' || attrs.duration === '0') unsupported();
      for (const name of ['media', 'initialization']) {
        let value = attrs[name];
        value = value.replace(/\$(RepresentationID|Bandwidth)\$/g, (_, token) => {
          const replacement = node.attrs[token === 'RepresentationID' ? 'id' : 'bandwidth'];
          if (!replacement || !(token === 'RepresentationID' ? /^[A-Za-z0-9_-]{1,128}$/ : /^\d{1,20}$/).test(replacement)) unsupported();
          return replacement;
        });
        const tokens = templateTokens(value);
        if (name === 'initialization' && tokens.length) unsupported();
        const target = resolveReference(value, localBase, config);
        // Match after URL normalization too; tokens in the authority cannot pass validation.
        const normalized = templateTokens(target);
        if (normalized.length !== tokens.length) unsupported();
        attrs[name] = collector.add(target, 'binary', tokens.length ? `/v${tokens.map(t => t[0]).join('-')}` : '');
      }
      for (const timeline of template.children) {
        if (!timeline.children.length) unsupported();
        for (const segment of timeline.children) {
          if (!/^\d{1,20}$/.test(segment.attrs.d || '') || /^0+$/.test(segment.attrs.d) ||
              (segment.attrs.t !== undefined && !/^\d{1,20}$/.test(segment.attrs.t)) ||
              (segment.attrs.r !== undefined && !/^(?:-1|\d{1,10})$/.test(segment.attrs.r))) unsupported();
        }
      }
      node.children.push({ name: 'SegmentTemplate', attrs, children: template.children, text: '' });
    } else {
      for (const child of node.children) walk(child, localBase, template);
    }
  }
  walk(root, base, null);
  if (!representations) unsupported();
  function serialize(node, path) {
    const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${xmlEscape(typeof value === 'string' ? value : path(value))}"`).join('');
    return node.children.length ? `<${node.name}${attrs}>${node.children.map(child => serialize(child, path)).join('')}</${node.name}>` : `<${node.name}${attrs}/>`;
  }
  return { links: collector.links, render: path => `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(root, path)}\n` };
}

function materializeDash(target, segment) {
  const tokens = templateTokens(target);
  if (!tokens.length) {
    if (segment !== undefined) fail(404, 'resource_not_found', 'Stream resource not found.');
    return target;
  }
  const match = typeof segment === 'string' && new RegExp(`^v${tokens.map(() => '(\\d{1,20})').join('-')}$`).exec(segment);
  if (!match) fail(404, 'resource_not_found', 'Stream resource not found.');
  let index = 0;
  return target.replace(/\$(Number|Time)(?:%0([1-9]|1[0-2])d)?\$/g, () => match[++index]);
}

function requestRange(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(value)) fail(416, 'invalid_range', 'A single byte range is required.');
  const [start, end] = value.slice(6).split('-');
  if ((start && end && BigInt(start) > BigInt(end)) || (!start && BigInt(end) === 0n)) fail(416, 'invalid_range', 'Invalid byte range.');
  return value;
}

const ENTITLEMENT = `
  (NOT c.premium OR EXISTS (
    SELECT 1 FROM subscriptions sub WHERE sub.user_id=$1 AND sub.started_at<=now()
      AND sub.expires_at>now() AND sub.cancelled_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM trials t WHERE t.user_id=$1 AND t.started_at<=now() AND t.expires_at>now()
  )) AS entitled`;

// Optional lookup/request dependencies are for deterministic transport tests. They
// never bypass URL validation, DNS address checks, redirect policy or size limits.
export function createStreamService({ pool, config, lookup = dnsLookup, request = https.request }) {
  const hooks = { lookup, request };
  const publicOrigin = new URL(config.publicBaseUrl).origin;
  async function authorize(db, user, sessionHash, channelId, playbackId, resourceId) {
    if (!user || !UUID.test(user.id || '') || !/^[a-f0-9]{64}$/.test(sessionHash || '')) fail(401, 'unauthorized', 'Authentication required.');
    if (user.status !== 'active') fail(403, 'account_inactive', 'The account is not active.');
    const session = await db.query(`SELECT u.status FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$2 AND s.user_id=$1 AND s.expires_at>now()`, [user.id, sessionHash]);
    if (!session.rowCount) fail(401, 'unauthorized', 'Authentication required.');
    if (session.rows[0].status !== 'active') fail(403, 'account_inactive', 'The account is not active.');
    let result;
    if (playbackId) {
      if (!UUID.test(playbackId) || !UUID.test(resourceId || '')) fail(404, 'resource_not_found', 'Stream resource not found.');
      result = await db.query(`SELECT c.*, p.id AS playback_id, p.expires_at,
        p.expires_at>now() AS unexpired, p.channel_version=c.updated_at AS current_version,
        r.id AS resource_id, r.url_encrypted, r.kind, ${ENTITLEMENT}
        FROM playback_sessions p JOIN channels c ON c.id=p.channel_id
        JOIN playback_resources r ON r.playback_id=p.id AND r.id=$4
        WHERE p.id=$3 AND p.user_id=$1 AND p.session_hash=$2`, [user.id, sessionHash, playbackId, resourceId]);
      if (!result.rowCount) fail(404, 'resource_not_found', 'Stream resource not found.');
      if (!result.rows[0].unexpired) fail(410, 'playback_expired', 'Request a new playback URL.');
      if (!result.rows[0].current_version) fail(403, 'channel_changed', 'Request a new playback URL.');
    } else {
      if (!UUID.test(channelId || '')) fail(404, 'channel_not_found', 'Channel not found.');
      result = await db.query(`SELECT c.*, ${ENTITLEMENT} FROM channels c WHERE c.id=$2 FOR SHARE OF c`, [user.id, channelId]);
      if (!result.rowCount) fail(404, 'channel_not_found', 'Channel not found.');
    }
    const row = result.rows[0];
    if (!row.active || !row.licensed || !row.stream_url_encrypted || !MIME[row.stream_type]) fail(403, 'channel_unavailable', 'This channel is not available for licensed playback.');
    if (!row.entitled) fail(403, 'subscription_required', 'An active subscription or remaining trial is required.');
    return row;
  }

  async function storeLinks(db, playbackId, links) {
    const unique = new Map();
    for (const link of links) {
      const hash = sha256(link.target);
      const key = `${hash}:${link.kind}`;
      if (!unique.has(key)) {
        const id = randomUUID();
        unique.set(key, { id, hash, kind: link.kind, encrypted: encrypt(link.target, config.encryptionKey, resourceContext(playbackId, id)) });
      }
    }
    if (!unique.size) return () => { throw upstreamError(); };
    // Serialize resource registration for this session to bound total storage.
    await db.query('SELECT id FROM playback_sessions WHERE id=$1 FOR UPDATE', [playbackId]);
    const existing = await db.query('SELECT url_hash,kind FROM playback_resources WHERE playback_id=$1', [playbackId]);
    const keys = new Set(existing.rows.map(r => `${r.url_hash}:${r.kind}`));
    const additional = [...unique.keys()].filter(key => !keys.has(key)).length;
    if (keys.size + additional > MAX_RESOURCES) fail(422, 'resource_limit', 'Request a new playback URL.');
    const result = await db.query(`INSERT INTO playback_resources(id,playback_id,url_encrypted,url_hash,kind)
      SELECT x.id,$1,x.encrypted,x.hash,x.kind
      FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,encrypted text,hash text,kind text)
      ON CONFLICT(playback_id,url_hash,kind) DO UPDATE SET url_hash=EXCLUDED.url_hash
      RETURNING id,url_hash,kind`, [playbackId, JSON.stringify([...unique.values()])]);
    const paths = new Map(result.rows.map(r => [`${r.url_hash}:${r.kind}`, resourcePath(playbackId, r.id)]));
    return link => `${paths.get(`${sha256(link.target)}:${link.kind}`)}${link.tail}`;
  }

  async function playback(user, sessionHash, channelId) {
    return transaction(pool, async db => {
      const channel = await authorize(db, user, sessionHash, channelId);
      let target;
      try { target = validateStreamUrl(decrypt(channel.stream_url_encrypted, config.encryptionKey, `channel:${channel.id}:stream`), config); }
      catch { throw upstreamError(); }
      const id = randomUUID();
      // Preserve PostgreSQL's full timestamp precision for the version snapshot.
      const result = await db.query(`INSERT INTO playback_sessions(id,user_id,session_hash,channel_id,channel_version,expires_at)
        SELECT $3,$1,$2,c.id,c.updated_at,LEAST(now()+interval '10 minutes',s.expires_at,
          CASE WHEN c.premium THEN GREATEST(
            (SELECT sub.expires_at FROM subscriptions sub WHERE sub.user_id=$1 AND sub.started_at<=now() AND sub.expires_at>now() AND sub.cancelled_at IS NULL),
            (SELECT t.expires_at FROM trials t WHERE t.user_id=$1 AND t.started_at<=now() AND t.expires_at>now())
          ) ELSE 'infinity'::timestamptz END)
        FROM channels c JOIN sessions s ON s.token_hash=$2 AND s.user_id=$1 AND s.expires_at>now()
        WHERE c.id=$4 RETURNING expires_at`, [user.id, sessionHash, id, channelId]);
      if (!result.rowCount) fail(401, 'unauthorized', 'Authentication required.');
      const link = { target, kind: 'manifest', tail: '' };
      const path = await storeLinks(db, id, [link]);
      return { url: `${publicOrigin}${path(link)}`, mimeType: MIME[channel.stream_type], expiresAt: result.rows[0].expires_at.toISOString() };
    });
  }

  async function proxy(req, res) {
    const { playbackId, resourceId, segment } = req.params || {};
    if (!playbackId || !resourceId) fail(404, 'resource_not_found', 'Stream resource not found.');
    if (req.method && req.method !== 'GET') fail(405, 'method_not_allowed', 'Use GET for stream playback.');
    const row = await authorize(pool, req.user, req.sessionHash, null, playbackId, resourceId);
    // Upstream queries are encrypted in the resource. Client query parameters,
    // including URL overrides and LL-HLS controls, are never forwarded.
    if (Object.keys(req.query || {}).length) fail(400, 'unexpected_query', 'Stream proxy query parameters are not supported.');
    let target;
    try { target = decrypt(row.url_encrypted, config.encryptionKey, resourceContext(playbackId, resourceId)); }
    catch { throw upstreamError(); }
    if (row.stream_type === 'dash' && row.kind === 'binary') target = materializeDash(target, segment);
    else if (segment !== undefined) fail(404, 'resource_not_found', 'Stream resource not found.');
    const range = requestRange(req.headers?.range);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HttpError(504, 'stream_timeout', 'The licensed stream timed out.')), REQUEST_MS);
    timer.unref?.();
    const disconnect = () => controller.abort(upstreamError());
    req.once?.('aborted', disconnect);
    res.once?.('close', disconnect);
    try {
      const upstream = await fetchUpstream(target, config, hooks, range, row.kind === 'manifest', controller.signal);
      const isManifest = row.kind === 'manifest' || manifestPath(upstream.url) || manifestType(upstream.headers) || manifestBody(upstream.body);
      let body = upstream.body;
      let contentType;
      let status = upstream.status;
      if (isManifest) {
        if (body.length > MANIFEST_LIMIT || status !== 200) unsupported();
        const manifest = row.stream_type === 'hls' ? rewriteHls(body, upstream.url, config) : rewriteDash(body, upstream.url, config);
        const path = await transaction(pool, async db => {
          await authorize(db, req.user, req.sessionHash, null, playbackId, resourceId);
          return storeLinks(db, playbackId, manifest.links);
        });
        body = Buffer.from(manifest.render(path));
        if (body.length > 4 * MANIFEST_LIMIT) unsupported();
        contentType = MIME[row.stream_type];
        status = 200;
      } else {
        const type = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const allowed = /^(?:video\/(?:mp2t|mp4|webm)|audio\/(?:mp4|mpeg|aac|aacp|webm)|application\/(?:octet-stream|mp4)|text\/vtt)$/;
        if (type && !allowed.test(type)) throw upstreamError();
        contentType = type || 'application/octet-stream';
        if (status === 206) {
          const value = upstream.headers['content-range'];
          const match = typeof value === 'string' && /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16}|\*)$/.exec(value);
          if (!range || !match || BigInt(match[2]) < BigInt(match[1]) || BigInt(match[2]) - BigInt(match[1]) + 1n !== BigInt(body.length) ||
              (match[3] !== '*' && BigInt(match[2]) >= BigInt(match[3]))) throw upstreamError();
        }
      }
      // Revocation during a slow fetch must take effect before sending any bytes.
      await authorize(pool, req.user, req.sessionHash, null, playbackId, resourceId);
      if (controller.signal.aborted) throw controller.signal.reason;
      res.status(status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Vary', 'Authorization');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!isManifest && status === 206) res.setHeader('Content-Range', upstream.headers['content-range']);
      if (!isManifest && upstream.headers['accept-ranges'] === 'bytes') res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', body.length);
      res.end(body);
    } finally {
      clearTimeout(timer);
      req.removeListener?.('aborted', disconnect);
      res.removeListener?.('close', disconnect);
    }
  }

  // Mount both with the same Bearer authentication middleware. No wildcard route
  // is needed: DASH's segment is a strictly validated numeric substitution tuple.
  // GET /v1/streams/:playbackId/:resourceId
  // GET /v1/streams/:playbackId/:resourceId/:segment
  return { playback, proxy };
}
