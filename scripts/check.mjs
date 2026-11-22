import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {SCHEMA_VERSION} from '../shared/archive.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const [pkg, lock, manifest] = await Promise.all([
  readJson('package.json'), readJson('package-lock.json'), readJson('extension/manifest.json'),
]);
assert.match(pkg.version, /^\d+\.\d+\.\d+$/u);
assert.equal(lock.version, pkg.version);
assert.equal(manifest.version, pkg.version);
assert.equal(SCHEMA_VERSION, 2);

for (const folder of ['cli', 'extension', 'shared', 'scripts', 'src/dom', 'tests']) {
  const files = await readdir(folder, {recursive: true, withFileTypes: true});
  for (const file of files) {
    if (!file.isFile() || !/\.m?js$/u.test(file.name)) continue;
    // DOM script fragments are function bodies and are syntax checked after bundling.
    if (folder === 'src/dom') continue;
    execFileSync(process.execPath, ['--check', `${file.parentPath}/${file.name}`], {stdio: 'inherit'});
  }
}
console.log(`Release versions match (${pkg.version}, schema ${SCHEMA_VERSION}) and JavaScript syntax checks passed.`);
