import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {formatArchive} from '../shared/archive.mjs';
import {demoArchive} from './demo-archive.mjs';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const packages = [
  `messscrap-chromium-${version}.zip`, `messscrap-firefox-${version}.zip`, `messscrap-${version}.tgz`,
];
const hashes = [];
for (const name of packages) {
  const bytes = await readFile(join('bin', name));
  hashes.push(createHash('sha256').update(bytes).digest('hex') + '  ' + name);
}

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
execFileSync(python, ['-c', `
import sys
from pathlib import Path
from zipfile import ZipFile
sys.path.insert(0, 'extension')
from build import validate_extension

version = sys.argv[1]
for target in ("chromium", "firefox"):
    folder = Path("bin") / (target + "-extension")
    with ZipFile(Path("bin") / f"messscrap-{target}-{version}.zip") as package:
        assert package.testzip() is None
        entries = package.namelist()
        assert len(entries) == len(set(entries))
        assert all(Path(entry).name == entry for entry in entries), entries
        files = {entry: package.read(entry) for entry in entries}
        validate_extension(files, target, version)
        assert set(entries) == {path.name for path in folder.iterdir()}, folder
        for entry, contents in files.items():
            assert contents == (folder / entry).read_bytes(), entry
`, version], {stdio: 'inherit'});
for (const target of ['chromium', 'firefox']) {
  const folder = `bin/${target}-extension`;
  for (const filename of await readdir(folder)) {
    if (filename.endsWith('.js')) execFileSync(process.execPath, ['--check', join(folder, filename)]);
  }
}

const workspace = await mkdtemp(join(tmpdir(), 'messscrap-distribution-'));
const isWindows = process.platform === 'win32';
try {
  const tarball = resolve('bin', packages[2]);
  await writeFile(join(workspace, 'package.json'), '{"private":true}');
  const npm = isWindows ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tarball], {
    cwd: workspace, stdio: 'inherit', shell: isWindows,
  });
  const shim = join(workspace, 'node_modules', '.bin', isWindows ? 'messscrap.cmd' : 'messscrap');
  const run = (...args) => execFileSync(shim, args, {
    cwd: workspace, encoding: 'utf8', shell: isWindows, env: {...process.env, NO_COLOR: '1'},
  }).trim();
  assert.equal(run('--version').replace(/^messscrap\s+/iu, ''), version);
  assert.match(run('--help'), /validate/iu);
  const fixture = demoArchive(42);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lpkAAAAASUVORK5CYII=', 'base64');
  const photo = fixture.messages[0].attachments[0];
  Object.assign(photo, {
    path: 'media/trail-photo.png', status: 'archived', size: image.length,
    sha256: createHash('sha256').update(image).digest('hex'),
  });
  await mkdir(join(workspace, 'media'));
  await writeFile(join(workspace, photo.path), image);
  await writeFile(join(workspace, 'synthetic.json'), formatArchive(fixture, 'json'));
  run('validate', 'synthetic.json');
  assert.match(run('search', 'synthetic.json', 'weather'), /weather/iu);
  assert.match(run('stats', 'synthetic.json', '--format', 'json'), /42/u);

  for (const format of ['txt', 'json', 'csv', 'html', 'zip']) {
    run('export', 'synthetic.json', '--format', format, '--out', `archive.${format}`);
    assert((await readFile(join(workspace, `archive.${format}`))).length > 50);
  }
  execFileSync(python, ['-c', `
import json
from zipfile import ZipFile
with ZipFile('archive.zip') as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == {'index.html', 'messages.json', 'messages.txt', 'messages.csv',
        'metadata.json', 'statistics.json', 'manifest.json', 'README.txt'}
    payload = json.loads(archive.read('messages.json'))
    assert payload['schemaVersion'] == 2
    assert len(payload['messages']) == 42
    assert json.loads(archive.read('manifest.json'))['media']['skipped'] > 0
`], {cwd: workspace, stdio: 'inherit'});
  run('validate', 'archive.zip');
  run('export', 'synthetic.json', '--format', 'zip', '--media', '--out', 'archive-with-media.zip');
  run('validate', 'archive-with-media.zip');
  execFileSync(python, ['-c', `
import json
from zipfile import ZipFile
with ZipFile('archive-with-media.zip') as archive:
    manifest = json.loads(archive.read('manifest.json'))
    assert manifest['media']['archived'] == 1
    item = manifest['attachments'][0]
    assert item['path'].startswith('media/images/')
    assert archive.read(item['path']) == open('media/trail-photo.png', 'rb').read()
`], {cwd: workspace, stdio: 'inherit'});
  await writeFile('bin/SHA256SUMS', hashes.join('\n') + '\n');
  console.log(`Installed MessScrap ${version} and verified all five formats, archive validation and extension ZIPs.`);
} finally {
  await rm(workspace, {recursive: true, force: true});
}
