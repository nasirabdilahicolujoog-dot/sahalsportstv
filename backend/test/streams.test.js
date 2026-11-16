import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createStreamService, validateStreamUrl } from '../src/streams.js';
import { encrypt, decrypt, sha256 } from '../src/security.js';

const config = {
  publicBaseUrl: 'https://app.example.com',
  encryptionKey: Buffer.alloc(32, 71),
  streamHosts: new Set(['licensed.example.com', 'cdn.example.com']),
};
const rootUrl = 'https://licensed.example.com/live/master?credential=server-only';
const goodAddress = { address: '93.184.216.34', family: 4 };
const statusError = status => error => error.status === status && !/licensed\.example|credential=|server-only/.test(error.message);

// Transport is injected, not an allowlist/DNS bypass. Tests still execute the
// production URL validation, address policy and custom pinned lookup callback.
function transport(fixtures, seen, onRequest) {
  return (url, options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroyed = false;
    outgoing.destroy = () => { outgoing.destroyed = true; };
    outgoing.end = () => queueMicrotask(async () => {
      try {
        if (outgoing.destroyed) return;
        seen.push({ url: url.href, options });
        await onRequest?.(url, options);
        const fixture = fixtures.get(url.href);
        if (!fixture) throw new Error('Missing transport fixture');
        const incoming = new PassThrough();
        incoming.statusCode = fixture.status || 200;
        incoming.headers = { ...fixture.headers };
        callback(incoming);
        if (!incoming.destroyed) incoming.end(fixture.body || '');
      } catch (error) { outgoing.emit('error', error); }
    });
    return outgoing;
  };
}

function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.status = code => { res.statusCode = code; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.end = body => { res.body = Buffer.from(body); res.headersSent = true; };
  return res;
}

// This small repository double only supports transport/manifest unit tests.
// Ownership, TTL and SQL semantics are independently tested against PostgreSQL below.
function harness({ type = 'hls', url = rootUrl, body = '#EXTM3U\n#EXT-X-ENDLIST\n', headers = {}, lookup, onRequest } = {}) {
  const user = { id: randomUUID(), role: 'customer', status: 'active' };
  const sessionHash = sha256('unit-test-session');
  const playbackId = randomUUID();
  const resourceId = randomUUID();
  const root = { id: resourceId, kind: 'manifest', url_hash: sha256(url), url_encrypted: encrypt(url, config.encryptionKey, `playback:${playbackId}:resource:${resourceId}`) };
  const resources = new Map([[resourceId, root]]);
  const row = { id: randomUUID(), active: true, licensed: true, stream_url_encrypted: 'present', stream_type: type,
    entitled: true, current_version: true, unexpired: true };
  const result = rows => ({ rows, rowCount: rows.length });
  const pool = {
    connect: async () => ({ query: (...args) => pool.query(...args), release() {} }),
    async query(sql, values = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return result([]);
      if (sql.startsWith('SELECT u.status')) return result([{ status: 'active' }]);
      if (sql.includes('FROM playback_sessions p JOIN channels')) {
        const resource = resources.get(values[3]);
        return result(resource && values[2] === playbackId ? [{ ...row, ...resource, resource_id: resource.id }] : []);
      }
      if (sql.startsWith('SELECT id FROM playback_sessions')) return result([{ id: playbackId }]);
      if (sql.startsWith('SELECT url_hash,kind')) return result([...resources.values()]);
      if (sql.startsWith('INSERT INTO playback_resources')) {
        return result(JSON.parse(values[1]).map(record => {
          const existing = [...resources.values()].find(r => r.url_hash === record.hash && r.kind === record.kind);
          if (existing) return existing;
          const resource = { id: record.id, kind: record.kind, url_hash: record.hash, url_encrypted: record.encrypted };
          resources.set(resource.id, resource);
          return resource;
        }));
      }
      throw new Error(`Unexpected test repository statement: ${sql.slice(0, 60)}`);
    },
  };
  const fixtures = new Map([[url, { body, headers }]]);
  const seen = [];
  const dns = [];
  const service = createStreamService({ pool, config,
    lookup: async (host, options) => { dns.push(host); return lookup ? lookup(host, options) : [goodAddress]; },
    request: transport(fixtures, seen, onRequest),
  });
  const rootPath = `/v1/streams/${playbackId}/${resourceId}`;
  async function invoke(path = rootPath, overrides = {}) {
    const parsed = new URL(path, config.publicBaseUrl);
    const [, , , playback, resource, segment] = parsed.pathname.split('/');
    const req = Object.assign(new EventEmitter(), {
      method: 'GET', user, sessionHash, params: { playbackId: playback, resourceId: resource, segment },
      headers: { authorization: 'Bearer MUST-NOT-REACH-UPSTREAM' }, query: Object.fromEntries(parsed.searchParams),
    }, overrides);
    const res = response();
    await service.proxy(req, res);
    return res;
  }
  function target(path) {
    const id = new URL(path, config.publicBaseUrl).pathname.split('/')[4];
    const resource = resources.get(id);
    assert.ok(resource, 'rewritten resource was persisted');
    return decrypt(resource.url_encrypted, config.encryptionKey, `playback:${playbackId}:resource:${id}`);
  }
  return { invoke, target, rootPath, resources, fixtures, seen, dns, row, service, user, sessionHash };
}

function paths(text) { return [...new Set(text.match(/\/v1\/streams\/[a-f0-9-]+\/[a-f0-9-]+/g) || [])]; }

 test('validator returns a canonical exact-host HTTPS URL', () => {
  assert.equal(validateStreamUrl('https://LICENSED.example.com:443/a/../playlist.m3u8?token=x%2Fy', config), 'https://licensed.example.com/playlist.m3u8?token=x%2Fy');
  assert.equal(validateStreamUrl('https://cdn.example.com/stream', config), 'https://cdn.example.com/stream');
});

for (const value of [
  'http://licensed.example.com/live', 'ftp://licensed.example.com/live',
  'https://user:password@licensed.example.com/live', 'https://@licensed.example.com/live',
  'https://licensed.example.com:444/live', 'https://licensed.example.com:0443/live',
  'https://licensed.example.com./live', 'https://evil.licensed.example.com/live',
  'https://licensed.example.com.evil.com/live', 'https://other.example.com/live',
  'https://127.0.0.1/live', 'https://10.0.0.1/live', 'https://169.254.169.254/live',
  'https://93.184.216.34/live', 'https://2130706433/live', 'https://0177.0.0.1/live',
  'https://0x7f000001/live', 'https://[::1]/live', 'https://[::]/live',
  'https://[::ffff:127.0.0.1]/live', 'https://[fe80::1]/live', 'https://[fc00::1]/live',
  'https://localhost/live', 'https://licensed.example.com/live#secret',
  'https://licensed.example.com/live#', 'https://licensed.example.com\\@evil.com/live',
  ' https://licensed.example.com/live', 'https://licensed.example.com/\nstream',
  'https://%6cicensed.example.com/live', '//licensed.example.com/live', null, '',
]) {
  test(`validator rejects ${JSON.stringify(value)}`, () => assert.throws(() => validateStreamUrl(value, config), statusError(400)));
}

test('literal IPs remain forbidden even when accidentally allowlisted', () => {
  for (const host of ['127.0.0.1', '93.184.216.34', '[::ffff:127.0.0.1]']) {
    assert.throws(() => validateStreamUrl(`https://${host}/live`, { ...config, streamHosts: new Set([host]) }), statusError(400));
  }
});

for (const address of [
  '127.0.0.1', '0.0.0.0', '10.2.3.4', '172.16.0.1', '192.168.1.1', '169.254.169.254',
  '100.64.0.1', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1',
  '::', '::1', 'fe80::1', 'fc00::1', 'fd00::1234', 'ff02::1', '2001:db8::1',
  '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::',
]) {
  test(`DNS rejects non-public destination ${address}`, async () => {
    const h = harness({ lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    await assert.rejects(h.invoke(), statusError(502));
    assert.equal(h.seen.length, 0);
  });
}

test('mixed safe and private DNS answers fail closed', async () => {
  const h = harness({ lookup: async () => [goodAddress, { address: '::ffff:169.254.169.254', family: 6 }] });
  await assert.rejects(h.invoke(), statusError(502));
  assert.equal(h.seen.length, 0);
});

test('pins DNS, retains TLS hostname verification, and never forwards Bearer/cookies', async () => {
  const h = harness();
  await h.invoke(undefined, { headers: { authorization: 'Bearer secret', cookie: 'secret=1', host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com' } });
  const options = h.seen[0].options;
  assert.equal(options.agent, false);
  assert.equal(options.servername, 'licensed.example.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers.authorization, undefined);
  assert.equal(options.headers.cookie, undefined);
  assert.equal(options.headers['Accept-Encoding'], 'identity');
  options.lookup('licensed.example.com', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [goodAddress]);
  });
  options.lookup('licensed.example.com', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, goodAddress.address); assert.equal(family, 4);
  });
  options.lookup('evil.example.com', {}, error => assert.equal(error.status, 502));
});

test('global unicast IPv6 can be pinned without using a literal URL', async () => {
  const h = harness({ lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }] });
  assert.equal((await h.invoke()).statusCode, 200);
});

test('all redirects revalidate host and DNS, and resolve playlists against the final URL', async () => {
  const h = harness();
  const final = 'https://cdn.example.com/redirected/master?server=secret';
  h.fixtures.set(rootUrl, { status: 302, headers: { location: final } });
  h.fixtures.set(final, { body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nvariant?token=two\n' });
  const res = await h.invoke();
  assert.deepEqual(h.dns, ['licensed.example.com', 'cdn.example.com']);
  assert.equal(h.target(paths(res.body.toString())[0]), 'https://cdn.example.com/redirected/variant?token=two');
  assert.doesNotMatch(res.body.toString(), /https:|secret|token=|example\.com/);
  assert.equal(res.headers.location, undefined);
});

for (const location of ['https://evil.example.com/private', 'http://cdn.example.com/live', 'https://127.0.0.1/private', 'https://user@cdn.example.com/private']) {
  test(`rejects unsafe redirect ${location}`, async () => {
    const h = harness();
    h.fixtures.set(rootUrl, { status: 302, headers: { location } });
    await assert.rejects(h.invoke(), statusError(502));
    assert.equal(h.seen.length, 1);
  });
}

test('same-host redirect cannot rebind DNS to a private address', async () => {
  let resolutions = 0;
  const h = harness({ lookup: async () => [++resolutions === 1 ? goodAddress : { address: '127.0.0.1', family: 4 }] });
  h.fixtures.set(rootUrl, { status: 302, headers: { location: '/second' } });
  await assert.rejects(h.invoke(), statusError(502));
  assert.equal(resolutions, 2);
  assert.equal(h.seen.length, 1);
});

test('redirect chains and loops are bounded', async () => {
  const h = harness();
  h.fixtures.set(rootUrl, { status: 302, headers: { location: rootUrl } });
  await assert.rejects(h.invoke(), statusError(502));
  assert.equal(h.seen.length, 5);
});

test('client URL/query overrides and unsupported byte ranges cannot cause upstream requests', async () => {
  for (const query of ['?url=https://evil.example.com', '?_HLS_msn=3', '?token=override']) {
    const h = harness();
    await assert.rejects(h.invoke(h.rootPath + query), statusError(400));
    assert.equal(h.seen.length, 0);
  }
  for (const range of ['bytes=0-1,3-4', 'bytes=9-1', 'bytes=-0', 'items=1-2', 'bytes=0-1\r\nAuthorization: secret']) {
    const h = harness();
    await assert.rejects(h.invoke(undefined, { headers: { range } }), statusError(416));
    assert.equal(h.seen.length, 0);
  }
});

test('HLS master rewrites extensionless variants and rendition URI attributes', async () => {
  const h = harness({ body: '#EXTM3U\n# comment https://licensed.example.com/secret\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English, stereo",URI="audio?key=a%2Fb"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,URI="iframe?key=i"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio"\nchild?key=v\n' });
  const first = await h.invoke();
  const output = first.body.toString();
  const rewritten = paths(output);
  assert.equal(rewritten.length, 3);
  assert.doesNotMatch(output, /https:|example\.com|\?key=/);
  assert.match(output, /NAME="English, stereo"/);
  for (const path of rewritten) assert.equal(h.resources.get(path.split('/')[4]).kind, 'manifest');
  const second = await h.invoke();
  assert.equal(second.body.toString(), output, 'repeat reloads reuse resource UUIDs');
  assert.equal(h.resources.size, 4);
  assert.equal(first.headers['cache-control'], 'private, no-store');
  assert.equal(first.headers.vary, 'Authorization');
  assert.equal(first.headers['content-type'], 'application/vnd.apple.mpegurl');
});

test('HLS media rewrites AES keys, maps, relative/query-only segments, and supports byte ranges', async () => {
  const h = harness({ body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="../key?secret=yes",IV=0x00000000000000000000000000000001\n#EXT-X-MAP:URI="init.mp4?sig=init",BYTERANGE="4@0"\n#EXTINF:6.0,https://licensed.example.com/unused-title\nsegment.m4s?sig=one\n#EXTINF:6.0,\n?part=two\n#EXT-X-ENDLIST\n' });
  const manifest = (await h.invoke()).body.toString();
  const links = paths(manifest);
  assert.equal(links.length, 4);
  assert.equal(h.target(links[0]), 'https://licensed.example.com/key?secret=yes');
  assert.equal(h.target(links[3]), 'https://licensed.example.com/live/master?part=two');
  assert.doesNotMatch(manifest, /secret=yes|sig=|part=|https:/);
  h.fixtures.set(h.target(links[0]), { body: Buffer.alloc(16, 4), headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'upstream-secret', location: 'https://evil.example.com' } });
  assert.equal((await h.invoke(links[0])).body.length, 16);
  h.fixtures.set(h.target(links[1]), { status: 206, body: 'abcd', headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes' } });
  const binary = await h.invoke(links[1], { headers: { range: 'bytes=0-3', authorization: 'Bearer not-upstream' } });
  assert.equal(binary.statusCode, 206);
  assert.equal(binary.headers['content-range'], 'bytes 0-3/10');
  assert.equal(binary.body.toString(), 'abcd');
  assert.equal(h.seen.at(-1).options.headers.Range, 'bytes=0-3');
  assert.equal(binary.headers['set-cookie'], undefined);
  assert.equal(binary.headers.location, undefined);
  for (const resource of h.resources.values()) assert.doesNotMatch(resource.url_encrypted, /https:|secret=yes|sig=/);
});

test('binary-looking resource with an HLS body is rewritten rather than leaked', async () => {
  const h = harness({ body: '#EXTM3U\n#EXTINF:5,\nopaque\n' });
  const child = paths((await h.invoke()).body.toString())[0];
  h.fixtures.set(h.target(child), { body: '#EXTM3U\n#EXTINF:5,\nhttps://cdn.example.com/segment.ts?secret=hidden\n', headers: { 'content-type': 'application/octet-stream' } });
  const res = await h.invoke(child);
  assert.equal(res.headers['content-type'], 'application/vnd.apple.mpegurl');
  assert.doesNotMatch(res.body.toString(), /https:|secret=hidden/);
  assert.equal(paths(res.body.toString()).length, 1);
});

for (const body of [
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example.com/key"\n',
  '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n',
  '#EXTM3U\n#EXT-X-MAP:URI="init",URI="other"\n',
  '#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="https://licensed.example.com/steering"\n',
  '#EXTM3U\n#EXT-X-DEFINE:NAME="host",VALUE="value"\n',
  '#EXTM3U\n#EXT-X-PART:DURATION=1,URI="part"\n',
  '#EXTM3U\n#EXT-X-SESSION-DATA:DATA-ID="data",URI="metadata"\n',
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n',
  '#EXTM3U\n#EXTINF:5,\nhttp://licensed.example.com/segment\n',
  '#EXTM3U\n#EXTINF:5,\n{$host}/segment\n',
  '<html>https://licensed.example.com/internal-error</html>',
]) {
  test(`HLS fails closed on unsupported input ${body.slice(0, 65)}`, async () => {
    const h = harness({ body });
    await assert.rejects(h.invoke(), statusError(422));
    assert.equal(h.resources.size, 1, 'no partial rewritten manifest resources committed');
  });
}

const basicDash = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT2S">
<BaseURL>../dash/</BaseURL><Period><BaseURL>period/</BaseURL>
<AdaptationSet mimeType="video/mp4" segmentAlignment="true">
<SegmentTemplate timescale="1" duration="6" startNumber="1" initialization="$RepresentationID$/init.mp4?sig=secret&amp;k=one" media="$RepresentationID$/seg-$Number%05d$.m4s?sig=secret&amp;k=two"/>
<Representation id="video" bandwidth="1000000" codecs="avc1.4d401f" width="1280" height="720"><BaseURL>representation/</BaseURL></Representation>
</AdaptationSet></Period></MPD>`;

test('DASH specializes inherited BaseURL/SegmentTemplate and securely substitutes numeric segments', async () => {
  const h = harness({ type: 'dash', body: basicDash });
  const manifest = (await h.invoke()).body.toString();
  assert.doesNotMatch(manifest, /BaseURL|https:|sig=secret|representation\/|RepresentationID/);
  assert.match(manifest, /xmlns="urn:mpeg:dash:schema:mpd:2011"/);
  const media = /media="([^"]+)"/.exec(manifest)[1];
  const init = /initialization="([^"]+)"/.exec(manifest)[1];
  assert.match(media, /\/v\$Number%05d\$$/);
  assert.equal(h.target(media), 'https://licensed.example.com/dash/period/representation/video/seg-$Number%05d$.m4s?sig=secret&k=two');
  const concrete = h.target(media).replace('$Number%05d$', '00007');
  h.fixtures.set(concrete, { body: 'segment-bytes', headers: { 'content-type': 'video/mp4' } });
  h.fixtures.set(h.target(init), { body: 'init-bytes', headers: { 'content-type': 'video/mp4' } });
  assert.equal((await h.invoke(media.replace('$Number%05d$', '00007'))).body.toString(), 'segment-bytes');
  assert.equal((await h.invoke(init)).body.toString(), 'init-bytes');
  const before = h.seen.length;
  for (const suffix of ['vhttps:%2F%2Fevil.example.com', 'v..', 'v1-2', 'v-1', 'v123456789012345678901']) {
    await assert.rejects(h.invoke(media.replace('v$Number%05d$', suffix)), statusError(404));
  }
  await assert.rejects(h.invoke(media.replace('/v$Number%05d$', '')), statusError(404));
  assert.equal(h.seen.length, before);
});

test('DASH supports SegmentTimeline, Time/Bandwidth substitution and multiple representations', async () => {
  const body = `<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="init-$Bandwidth$.mp4" media="seg-$Time$.m4s"><SegmentTimeline><S t="1000" d="6000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="one" bandwidth="1000"/><Representation id="two" bandwidth="2000"/></AdaptationSet></Period></MPD>`;
  const h = harness({ type: 'dash', body });
  const manifest = (await h.invoke()).body.toString();
  assert.equal((manifest.match(/<SegmentTemplate /g) || []).length, 2);
  assert.equal((manifest.match(/<S t="1000" d="6000" r="2"\/>/g) || []).length, 2);
  const media = /media="([^"]+)"/.exec(manifest)[1];
  assert.match(media, /\/v\$Time\$$/);
  const target = h.target(media).replace('$Time$', '7000');
  h.fixtures.set(target, { body: 'media', headers: { 'content-type': 'video/mp4' } });
  assert.equal((await h.invoke(media.replace('$Time$', '7000'))).body.toString(), 'media');
});

for (const [name, body] of [
  ['DTD and external entity', '<!DOCTYPE MPD [<!ENTITY x SYSTEM "https://licensed.example.com/private">]><MPD><Period/></MPD>'],
  ['XLink', basicDash.replace('<Period>', '<Period xlink:href="https://licensed.example.com/remote">')],
  ['XML base', basicDash.replace('<Period>', '<Period xml:base="https://licensed.example.com/remote">')],
  ['remote UTC timing', basicDash.replace('</MPD>', '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="https://licensed.example.com/time"/></MPD>')],
  ['remote location', basicDash.replace('</MPD>', '<Location>https://licensed.example.com/next</Location></MPD>')],
  ['multiple BaseURLs', basicDash.replace('<BaseURL>../dash/</BaseURL>', '<BaseURL>one/</BaseURL><BaseURL>two/</BaseURL>')],
  ['unapproved BaseURL', basicDash.replace('../dash/', 'https://evil.example.com/')],
  ['DRM', basicDash.replace('<Representation ', '<ContentProtection schemeIdUri="urn:uuid:unsupported"/><Representation ')],
  ['SegmentList', '<MPD><Period><AdaptationSet><Representation id="1"><SegmentList/></Representation></AdaptationSet></Period></MPD>'],
  ['SegmentBase', '<MPD><Period><AdaptationSet><Representation id="1"><SegmentBase/></Representation></AdaptationSet></Period></MPD>'],
  ['unknown template variable', basicDash.replace('$Number%05d$', '$SubNumber$')],
  ['malformed XML', basicDash.replace('</Period>', '</Representation>')],
  ['unknown entity', basicDash.replace('../dash/', '&undefined;/')],
]) {
  test(`DASH honestly rejects ${name}`, async () => {
    const h = harness({ type: 'dash', body });
    await assert.rejects(h.invoke(), statusError(422));
    assert.equal(h.resources.size, 1);
  });
}

test('manifest size, compression, upstream status and partial manifests are bounded/rejected', async () => {
  for (const fixture of [
    { body: '#EXTM3U\n' + ' '.repeat(1024 * 1024) },
    { body: '', headers: { 'content-length': String(32 * 1024 * 1024 + 1) } },
    { body: '#EXTM3U\n', headers: { 'content-encoding': 'gzip' } },
    { body: 'https://licensed.example.com/error', status: 403 },
    { body: 'https://licensed.example.com/error', status: 500 },
    { body: '#EXTM3U\n', headers: { 'content-length': '1000' } },
  ]) {
    const h = harness();
    h.fixtures.set(rootUrl, fixture);
    await assert.rejects(h.invoke(), statusError(502));
  }
  const h = harness();
  h.fixtures.set(rootUrl, { status: 206, body: '#EXTM3U\n' });
  await assert.rejects(h.invoke(), statusError(422));
});

test('expiry/license/version/entitlement are checked again after fetching', async () => {
  for (const [field, status] of [['unexpired', 410], ['licensed', 403], ['active', 403], ['current_version', 403], ['entitled', 403]]) {
    let h;
    h = harness({ onRequest: async () => { h.row[field] = false; } });
    await assert.rejects(h.invoke(), statusError(status));
  }
});

test('disconnect aborts an in-flight lookup without sending upstream or response bytes', async () => {
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const h = harness({ lookup: async () => { start(); return new Promise(() => {}); } });
  const req = Object.assign(new EventEmitter(), { method: 'GET', user: h.user, sessionHash: h.sessionHash,
    params: { playbackId: h.rootPath.split('/')[3], resourceId: h.rootPath.split('/')[4] }, headers: {}, query: {} });
  const res = response();
  const pending = h.service.proxy(req, res);
  await started;
  req.emit('aborted');
  await assert.rejects(pending, statusError(502));
  assert.equal(h.seen.length, 0);
  assert.equal(res.headersSent, undefined);
});

// The parent test runner supplies a freshly migrated database. No schema changes,
// real stream requests, or seeded copyrighted content are needed by this suite.
describe('PostgreSQL stream ownership, entitlement, TTL and encrypted resource mappings', { skip: !process.env.TEST_DATABASE_URL }, () => {
  let pool;
  const users = [];
  const channels = [];
  before(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  after(async () => {
    for (const id of channels) await pool.query('DELETE FROM channels WHERE id=$1', [id]);
    // Trials are immutable history: leave their users in the disposable test DB.
    for (const id of users) {
      await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await pool.query('DELETE FROM subscriptions WHERE user_id=$1', [id]);
      await pool.query("UPDATE users SET status='deleted',deleted_at=now() WHERE id=$1", [id]);
    }
    await pool.end();
  });
  async function fixture({ premium = false, trial = null, subscription = null, type = 'hls' } = {}) {
    const id = randomUUID();
    const suffix = String(BigInt(`0x${id.replaceAll('-', '').slice(0, 14)}`));
    const user = { id, role: 'customer', status: 'active' };
    await pool.query('INSERT INTO users(id,name,email,phone,password_hash) VALUES($1,$2,$3,$4,$5)',
      [id, 'Stream Test', `${id}@example.com`, `+${suffix}`, 'unused-by-stream-tests']);
    users.push(id);
    const sessionHash = sha256(randomUUID());
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sessionHash, id]);
    if (trial) {
      await pool.query(`INSERT INTO trials(user_id,started_at,expires_at)
        VALUES($1,now()-$2::interval,now()-$2::interval+interval '15 minutes')`, [id, trial === 'active' ? '10 minutes' : '20 minutes']);
    }
    if (subscription) {
      await pool.query(`INSERT INTO subscriptions(user_id,expires_at,cancelled_at)
        VALUES($1,now()+$2::interval,CASE WHEN $3 THEN now() ELSE NULL END)`, [id, subscription === 'expired' ? '-1 minute' : '1 day', subscription === 'cancelled']);
    }
    const channelId = randomUUID();
    await pool.query(`INSERT INTO channels(id,name,category,quality,stream_url_encrypted,stream_type,active,premium,licensed,updated_at)
      VALUES($1,'Licensed test fixture','Sports','HD',$2,$3,true,$4,true,'2025-01-01 00:00:00.123456+00')`,
    [channelId, encrypt(rootUrl, config.encryptionKey, `channel:${channelId}:stream`), type, premium]);
    channels.push(channelId);
    const fixtures = new Map([[rootUrl, { body: '#EXTM3U\n#EXTINF:5,\nsegment.ts?key=hidden\n#EXT-X-ENDLIST\n' }]]);
    const seen = [];
    const service = createStreamService({ pool, config, lookup: async () => [goodAddress], request: transport(fixtures, seen) });
    const playback = () => service.playback(user, sessionHash, channelId);
    async function invoke(url, identity = user, hash = sessionHash) {
      const [, , , playbackId, resourceId, segment] = new URL(url).pathname.split('/');
      const req = Object.assign(new EventEmitter(), { method: 'GET', user: identity, sessionHash: hash,
        params: { playbackId, resourceId, segment }, headers: {}, query: {} });
      const res = response();
      await service.proxy(req, res);
      return res;
    }
    return { user, sessionHash, channelId, service, playback, invoke, seen, fixtures };
  }

  test('creates opaque encrypted playback, preserves microsecond channel version, and rewrites with real SQL', async () => {
    const f = await fixture();
    const issued = await f.playback();
    assert.deepEqual(Object.keys(issued).sort(), ['expiresAt', 'mimeType', 'url']);
    assert.match(issued.url, /^https:\/\/app\.example\.com\/v1\/streams\/[a-f0-9-]+\/[a-f0-9-]+$/);
    assert.equal(issued.mimeType, 'application/vnd.apple.mpegurl');
    assert.ok(Date.parse(issued.expiresAt) <= Date.now() + 600000);
    assert.ok(Date.parse(issued.expiresAt) > Date.now() + 590000);
    const manifest = await f.invoke(issued.url);
    assert.doesNotMatch(manifest.body.toString(), /https:|key=hidden/);
    const child = paths(manifest.body.toString())[0];
    const second = await f.invoke(issued.url);
    assert.equal(second.body.toString(), manifest.body.toString());
    const rows = await pool.query('SELECT * FROM playback_resources WHERE playback_id=$1', [new URL(issued.url).pathname.split('/')[3]]);
    assert.equal(rows.rowCount, 2);
    for (const resource of rows.rows) {
      assert.ok(resource.url_encrypted.startsWith('v1.'));
      assert.doesNotMatch(resource.url_encrypted, /https:|key=hidden/);
      const target = decrypt(resource.url_encrypted, config.encryptionKey, `playback:${resource.playback_id}:resource:${resource.id}`);
      assert.equal(resource.url_hash, sha256(target));
    }
    f.fixtures.set('https://licensed.example.com/live/segment.ts?key=hidden', { body: Buffer.from([0x47, 1, 2, 3]), headers: { 'content-type': 'video/mp2t' } });
    assert.equal((await f.invoke(config.publicBaseUrl + child)).body[0], 0x47);
  });

  test('playback is bound to both database user and authenticating session', async () => {
    const owner = await fixture();
    const other = await fixture();
    const issued = await owner.playback();
    await assert.rejects(owner.invoke(issued.url, other.user, other.sessionHash), statusError(404));
    await assert.rejects(owner.invoke(issued.url, other.user, owner.sessionHash), statusError(401));
    const secondSession = sha256(randomUUID());
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [secondSession, owner.user.id]);
    await assert.rejects(owner.invoke(issued.url, owner.user, secondSession), statusError(404));
    const second = await owner.playback();
    const mixed = issued.url.slice(0, issued.url.lastIndexOf('/') + 1) + second.url.split('/').at(-1);
    await assert.rejects(owner.invoke(mixed), statusError(404));
    assert.equal(owner.seen.length, 0);
  });

  test('expiration, logout, suspension, licensing and channel changes immediately revoke playback', async () => {
    const mutations = [
      ["UPDATE playback_sessions SET expires_at=now()-interval '1 second' WHERE channel_id=$1", 410, 'channel'],
      ["UPDATE channels SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1", 403, 'channel'],
      ['UPDATE channels SET active=false,licensed=false WHERE id=$1', 403, 'channel'],
      ["UPDATE users SET status='suspended' WHERE id=$1", 403, 'user'],
      ['DELETE FROM sessions WHERE user_id=$1', 401, 'user'],
    ];
    for (const [sql, status, field] of mutations) {
      const f = await fixture();
      const issued = await f.playback();
      await pool.query(sql, [field === 'user' ? f.user.id : f.channelId]);
      await assert.rejects(f.invoke(issued.url), statusError(status));
      assert.equal(f.seen.length, 0);
    }
  });

  test('premium requires live subscription or remaining trial; no role bypass', async () => {
    for (const opts of [{}, { trial: 'expired' }, { subscription: 'expired' }, { subscription: 'cancelled' }]) {
      const f = await fixture({ premium: true, ...opts });
      await assert.rejects(f.playback(), statusError(403));
      await assert.rejects(f.service.playback({ ...f.user, role: 'admin' }, f.sessionHash, f.channelId), statusError(403));
    }
    for (const opts of [{ trial: 'active' }, { subscription: 'active' }]) {
      const f = await fixture({ premium: true, ...opts });
      const issued = await f.playback();
      assert.equal((await f.invoke(issued.url)).statusCode, 200);
      if (opts.trial) assert.ok(Date.parse(issued.expiresAt) <= Date.now() + 300000);
    }
  });

  test('subscription revocation is read from DB on every request, including segments', async () => {
    const f = await fixture({ premium: true, subscription: 'active' });
    const issued = await f.playback();
    const manifest = await f.invoke(issued.url);
    const segment = config.publicBaseUrl + paths(manifest.body.toString())[0];
    await pool.query('UPDATE subscriptions SET cancelled_at=now() WHERE user_id=$1', [f.user.id]);
    await assert.rejects(f.invoke(issued.url), statusError(403));
    await assert.rejects(f.invoke(segment), statusError(403));
    assert.equal(f.seen.length, 1);
  });

  test('unlicensed channel and expired authentication cannot create playback', async () => {
    const f = await fixture();
    await pool.query('UPDATE channels SET active=false,licensed=false WHERE id=$1', [f.channelId]);
    await assert.rejects(f.playback(), statusError(403));
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [f.sessionHash]);
    await assert.rejects(f.playback(), statusError(401));
  });
});
