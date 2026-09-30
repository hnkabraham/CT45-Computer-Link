import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Build the Mac Bluetooth helper on macOS with Xcode command-line tools.');
const out = path.join(root, 'native/bin');
fs.mkdirSync(out, { recursive: true });
for (const arch of ['arm64', 'x86_64']) {
  execFileSync('xcrun', ['clang', '-arch', arch, '-mmacosx-version-min=12.0', '-fobjc-arc', '-O2', '-Wall', '-Wextra',
    '-Wno-unused-parameter', '-framework', 'Foundation', '-framework', 'CoreBluetooth',
    path.join(root, 'native/bluetooth-mac.m'), '-o', path.join(out, `ct45-bluetooth-${arch}`)], { stdio: 'inherit' });
}
execFileSync('xcrun', ['lipo', '-create', path.join(out, 'ct45-bluetooth-arm64'), path.join(out, 'ct45-bluetooth-x86_64'),
  '-output', path.join(out, 'ct45-bluetooth')], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', path.join(out, 'ct45-bluetooth')], { stdio: 'inherit' });
