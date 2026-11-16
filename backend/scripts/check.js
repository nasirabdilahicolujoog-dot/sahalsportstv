import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) files.push(path);
  }
  return files;
}

try {
  const files = (await Promise.all(['src', 'scripts', 'test'].map(directory =>
    javascriptFiles(join(root, directory))))).flat().sort();
  let failures = 0;
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: root, stdio: 'inherit', shell: false, windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      failures++;
      console.error(`Syntax check failed: ${relative(root, file)}${result.error ? ` (${result.error.code || result.error.name})` : ''}`);
    }
  }

  const paths = new Set(files.map(file => relative(root, file).replaceAll('\\', '/')));
  const { scripts = {} } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(scripts)) {
    // Validate this package's local Node entry points, including test globs,
    // without executing scripts, loading modules, or connecting to a database.
    for (const match of command.matchAll(/(?:^|\s)((?:src|scripts|test)\/[^\s"']+\.(?:c|m)?js)(?=\s|$)/g)) {
      const entry = match[1];
      const pattern = new RegExp(`^${entry.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      if (![...paths].some(path => pattern.test(path))) {
        failures++;
        console.error(`Missing entry point for package script "${name}": ${entry}`);
      }
    }
  }
  if (failures) process.exitCode = 1;
  console.log(`Checked ${files.length} JavaScript files and package script entry points; ${failures} failure(s).`);
} catch (error) {
  console.error(`JavaScript checks could not complete (${error.code || error.name}).`);
  process.exitCode = 1;
}
