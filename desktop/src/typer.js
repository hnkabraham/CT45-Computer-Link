import { execFile } from 'node:child_process';

export const SUFFIXES = ['enter', 'tab', 'none'];

// Scanners emit control characters (GS separators in GS1 codes, trailing CR/LF). Typed as
// keystrokes they'd trigger shortcuts, so drop them; the chosen suffix adds Enter or Tab.
export function cleanForTyping(text) {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, '');
}

// The command that types `text` into whichever app has focus, or null if the platform isn't
// supported. The text travels as an argument or environment variable, never inside the
// script, so a barcode can't inject commands.
export function typeCommand(platform, text, suffix = 'enter') {
  const clean = cleanForTyping(text);
  if (platform === 'darwin') {
    const key = { enter: 'key code 36', tab: 'key code 48' }[suffix];
    const script = ['on run argv', 'tell application "System Events"', 'keystroke (item 1 of argv)'];
    if (key) script.push(key);
    script.push('end tell', 'end run');
    return { file: 'osascript', args: [...script.flatMap((line) => ['-e', line]), '--', clean], env: {} };
  }
  if (platform === 'win32') {
    const key = { enter: '{ENTER}', tab: '{TAB}' }[suffix] ?? '';
    // SendKeys treats + ^ % ~ ( ) { } [ ] as commands; wrapping each in braces types it literally.
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      "$t = $env:CT45_TEXT -replace '[+^%~(){}\\[\\]]', '{$0}'",
      `[System.Windows.Forms.SendKeys]::SendWait($t + '${key}')`,
    ].join('; ');
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      env: { CT45_TEXT: clean },
    };
  }
  return null;
}

// macOS reports a missing Accessibility permission with one of these.
export function isPermissionError(message) {
  return /not allowed|assistive access|\(-1719\)|\(-25211\)|\(1002\)|\(-1743\)/i.test(String(message));
}

// Scans that waited in the CT45's outbox (out of Wi-Fi range, computer asleep) arrive in a
// burst, possibly long after they were scanned. Typing them wherever the cursor happens to be
// now would be a surprise, so only scans sent within this long of being scanned are typed.
// Both times come from the CT45's clock, so the two clocks needn't agree.
export const LIVE_SCAN_MS = 60_000;

export function wasDelayed(scan) {
  return Number.isFinite(scan.sentAt) && scan.sentAt - scan.scannedAt > LIVE_SCAN_MS;
}

// Types scans one at a time, in order, so fast scanning can't interleave keystrokes. Typing a
// burst takes a while, so `skipReason()` is asked right before each scan is typed (is our own
// window in front now?) rather than when it arrived. Resolves to { typed: true } or
// { skipped: reason }.
export function createTyper({ platform = process.platform, run = runFile } = {}) {
  let chain = Promise.resolve();
  return function type(text, suffix, skipReason = () => null) {
    const cmd = typeCommand(platform, text, suffix);
    if (!cmd) return Promise.reject(new Error('Typing into other apps is only supported on macOS and Windows.'));
    const result = chain.then(async () => {
      const reason = skipReason();
      if (reason) return { skipped: reason };
      await run(cmd);
      return { typed: true };
    });
    chain = result.catch(() => {});
    return result;
  };
}

function runFile({ file, args, env }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, ...env }, timeout: 10_000, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve();
    });
  });
}
