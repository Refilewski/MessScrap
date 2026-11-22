import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('bin', { recursive: true });
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(command, ['pack', '--pack-destination', 'bin'], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
