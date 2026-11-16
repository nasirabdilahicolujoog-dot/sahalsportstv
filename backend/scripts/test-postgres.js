import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = process.env.POSTGRES_BIN || process.env.PG_BIN ||
  (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
const executable = name => bin ? join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name;
const controller = new AbortController();
let interrupted = 0;
const interrupt = signal => {
  interrupted = signal === 'SIGINT' ? 130 : 143;
  controller.abort();
};
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);

// Never let libpq environment defaults select an existing database or server.
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^PG/i.test(key) && !/^(?:DATABASE_URL|TEST_DATABASE_URL)$/i.test(key)));

function run(command, args, { label, inherit = false, cleanup = false, acceptFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: inherit ? 'inherit' : 'ignore',
      signal: cleanup ? undefined : controller.signal,
    });
    child.once('error', error => {
      // Do not include command arguments, environment, SQL, or credentials in failures.
      reject(new Error(`${label} could not run (${error.code || error.name}).`));
    });
    child.once('close', (code, signal) => {
      if (code === 0 || acceptFailure) resolveRun(code ?? 1);
      else reject(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`}).`));
    });
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  if (port === 5432) {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    return reservePort();
  }
  return {
    port,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  };
}

let temporaryDirectory;
let reservation;
let startAttempted = false;
let stopped = true;
try {
  // Expand files ourselves: cmd.exe does not expand test/*.test.js.
  const testDirectory = join(root, 'test');
  const tests = (await readdir(testDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => join(testDirectory, entry.name)).sort();
  if (!tests.length) throw new Error('No test/*.test.js files were found.');

  temporaryDirectory = await mkdtemp(join(tmpdir(), 'sahal-postgres-test-'));
  const data = join(temporaryDirectory, 'data');
  reservation = await reservePort();
  const port = reservation.port;
  const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/sahal_test`;
  Object.assign(environment, {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    PAYMENT_ADAPTER_MODULE: '',
    FCM_SERVICE_ACCOUNT_FILE: '',
    PROVIDER_ALLOWED_HOSTS: '',
    STREAM_ALLOWED_HOSTS: '',
    HOST: '127.0.0.1',
    PORT: '8080',
    TRUST_PROXY_HOPS: '0',
    SESSION_HOURS: '168',
  });

  await run(executable('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale'],
    { label: 'Initialize isolated PostgreSQL cluster' });
  await reservation.close();
  reservation = undefined;
  // Trust authentication exists ONLY in this temporary, loopback-only cluster.
  // Disabling Unix sockets also prevents access via a shared socket directory.
  startAttempted = true;
  stopped = false;
  await run(executable('pg_ctl'), ['-D', data, '-l', join(temporaryDirectory, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -c unix_socket_directories=`, '-w', '-t', '30', 'start'],
  { label: 'Start isolated PostgreSQL cluster' });
  await run(executable('createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres',
    '--maintenance-db=postgres', 'sahal_test'], { label: 'Create isolated test database' });

  for (const key of Object.keys(process.env)) if (/^PG/i.test(key)) delete process.env[key];
  Object.assign(process.env, environment);
  const { migrate } = await import('./migrate.js');
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/db.js');
  const pool = createPool(loadConfig(environment));
  try { await migrate(pool); }
  catch { throw new Error('Isolated test database migration failed; check schema and migration compatibility.'); }
  finally { await pool.end(); }

  console.log('Running tests against a temporary loopback-only PostgreSQL cluster.');
  process.exitCode = await run(process.execPath, ['--test', '--test-concurrency=1', ...tests],
    { label: 'Node test suite', inherit: true, acceptFailure: true });
} catch (error) {
  console.error(interrupted ? 'Test run interrupted; cleaning up its temporary cluster.' :
    `${error.message} PostgreSQL 18 binaries must be installed (or set POSTGRES_BIN).`);
  process.exitCode = interrupted || 1;
} finally {
  if (reservation) await reservation.close().catch(() => {});
  if (temporaryDirectory && startAttempted) {
    const data = join(temporaryDirectory, 'data');
    try {
      let code = await run(executable('pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop'],
        { label: 'Stop isolated PostgreSQL cluster', cleanup: true, acceptFailure: true });
      if (code !== 0) {
        // A failed start may already be stopped. Only status 3 means not running.
        const status = await run(executable('pg_ctl'), ['-D', data, 'status'],
          { label: 'Check isolated PostgreSQL status', cleanup: true, acceptFailure: true });
        if (status === 3) code = 0;
        else if (status === 0) code = await run(executable('pg_ctl'),
          ['-D', data, '-m', 'immediate', '-w', '-t', '30', 'stop'],
          { label: 'Stop remaining isolated PostgreSQL process', cleanup: true, acceptFailure: true });
      }
      stopped = code === 0;
    } catch { stopped = false; }
  }
  if (temporaryDirectory && stopped) {
    // The only recursive removal target is the directory returned by our mkdtemp.
    const ownedPath = resolve(temporaryDirectory);
    if (ownedPath !== resolve(tmpdir()) && basename(ownedPath).startsWith('sahal-postgres-test-')) {
      try { await rm(ownedPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch {
        console.error(`Could not remove this run's temporary directory: ${ownedPath}`);
        process.exitCode = 1;
      }
    }
  } else if (temporaryDirectory) {
    console.error(`Could not confirm the temporary cluster stopped; retained its files: ${temporaryDirectory}`);
    process.exitCode = 1;
  }
  if (interrupted) process.exitCode = interrupted;
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
