import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
if (process.platform !== 'linux') throw Error('USB recovery requires Linux and a local Docker daemon');
const root = fileURLToPath(new URL('../', import.meta.url));
if (/[\r\n]/.test(root)) throw Error('Repository path must not contain line breaks');
const directory = join(homedir(), '.config/systemd/user');
const quoted = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
await mkdir(directory, {recursive: true});
await writeFile(join(directory, 'ibuddy-usb-recovery.service'), `[Unit]
Description=Recover changed i-Buddy Docker USB mappings

[Service]
Type=oneshot
WorkingDirectory=${root.replaceAll('%', '%%')}
ExecStart=${quoted(process.execPath)} ${quoted(join(root, 'scripts/recover-usb.js'))}
TimeoutStartSec=60s
UMask=0077
NoNewPrivileges=yes
`, {mode: 0o600});
await writeFile(join(directory, 'ibuddy-usb-recovery.timer'), await readFile(new URL('../deploy/ibuddy-usb-recovery.timer', import.meta.url)), {mode: 0o600});
execFileSync('systemctl', ['--user', 'daemon-reload'], {stdio: 'inherit'});
execFileSync('systemctl', ['--user', 'enable', '--now', 'ibuddy-usb-recovery.timer'], {stdio: 'inherit'});
console.log('USB recovery timer enabled. For boot/logout operation: loginctl enable-linger ' + process.env.USER);
