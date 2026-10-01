// Focused regression for keyboard navigation versus barcode-wedge input.
// Run after android-polish-e2e.mjs on the same disposable emulator.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const serial = process.env.ANDROID_SERIAL;
assert.ok(serial?.startsWith('emulator-'), 'Select a disposable emulator, never the physical scanner');
const pkg = 'com.henokabraham.ct45tracker';
const adb = (...args) => execFileSync(process.env.ADB || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'), ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 });
assert.equal(adb('shell', 'getprop', 'ro.kernel.qemu').trim(), '1');
function screen() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
    if (xml.includes('<hierarchy')) return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
      const attr = (name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '';
      return { id: attr('resource-id').replace(`${pkg}:id/`, ''), text: attr('text'), selected: attr('selected') === 'true', focused: attr('focused') === 'true', bounds: attr('bounds').match(/\d+/g)?.map(Number) };
    });
  }
  throw new Error('Accessibility snapshot unavailable');
}
function tap(id) {
  const b = screen().find((n) => n.id === id)?.bounds;
  assert.ok(b, `${id} must be visible`);
  adb('shell', 'input', 'tap', String((b[0] + b[2]) >> 1), String((b[1] + b[3]) >> 1));
}
function savedScans() {
  const prefs = adb('shell', 'run-as', pkg, 'cat', 'shared_prefs/ct45tracker.xml');
  const encoded = prefs.match(/<string name="scans">([\s\S]*?)<\/string>/)?.[1];
  assert.ok(encoded, 'Submitted scans must be saved');
  return JSON.parse(encoded.replace(/&(quot|apos|lt|gt|amp);/g, (_, name) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name]));
}

adb('install', '-r', '../android/app/build/outputs/apk/debug/app-debug.apk');
adb('shell', 'am', 'force-stop', pkg);
try {
  adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  tap('nav_scan');
  let focused;
  for (let attempt = 0; attempt < 20; attempt++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_TAB');
    focused = screen().find((n) => n.focused)?.id;
    if (focused === 'nav_history') break;
  }
  assert.equal(focused, 'nav_history', 'History must be keyboard reachable');
  adb('shell', 'input', 'keyevent', 'KEYCODE_SPACE');
  assert.ok(screen().find((n) => n.id === 'nav_history' && n.selected), 'Space should activate the focused navigation button');
  assert.ok(!screen().some((n) => n.id === 'manual'), 'Space activation must not open barcode entry');
  console.log('PASS Tab and Space navigate without being captured as barcode input');
  tap('nav_scan');
  adb('shell', 'input', 'text', 'KEYBOARD-002');
  assert.equal(screen().find((n) => n.id === 'manual')?.text, 'KEYBOARD-002');
  console.log('PASS printable keyboard input still opens entry with exact barcode text');
  adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
  let nodes = screen();
  assert.equal(nodes.find((n) => n.id === 'manual')?.text, 'Type or paste a barcode');
  assert.equal(savedScans()[0].data, 'KEYBOARD-002');
  console.log('PASS Enter submits the complete keyboard barcode');
  tap('settings_toggle');
  // Do not wait for a layout or accessibility snapshot between typing and Enter.
  const burst = '0000123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-01234567890123456789';
  adb('shell', 'input', 'text', burst);
  adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
  nodes = screen();
  assert.ok(nodes.find((n) => n.id === 'nav_scan' && n.selected));
  assert.equal(nodes.find((n) => n.id === 'manual')?.text, 'Type or paste a barcode');
  assert.equal(savedScans()[0].data, burst);
  console.log('PASS fast keyboard input from Settings retains every character and submits');
} finally {
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
}
