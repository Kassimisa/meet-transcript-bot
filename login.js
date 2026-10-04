// Run this ONCE: node login.js
//
// IMPORTANT: This launches REAL Google Chrome directly as a plain process —
// NOT through Playwright/CDP automation. Google actively detects and blocks
// sign-in from any browser being remote-controlled (via Chrome DevTools
// Protocol), even when it's genuine, correctly-branded Chrome. That's the
// exact "This browser or app may not be secure" wall you hit before.
//
// So the login step here uses zero automation: it just starts Chrome like
// double-clicking its icon would, pointed at a dedicated profile folder.
// You log in totally normally. Playwright (bot.js) only touches that
// profile folder AFTER login, to read the already-saved cookies — it
// doesn't need to redo the sign-in flow, so it never trips the same check.
//
// Log into your Google account in the window that opens, then close it.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const USER_DATA_DIR = path.join(__dirname, 'google-session');

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch (_) {
      return false;
    }
  });
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Could not find Google Chrome on this machine.');
  console.error('Install it from https://www.google.com/chrome/ and run "node login.js" again.');
  process.exit(1);
}

console.log('Using Chrome at:', chromePath);
console.log('Opening a plain, non-automated Chrome window — log into your Google');
console.log('account normally, then just close the window when you are done.');

const child = spawn(
  chromePath,
  [
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://accounts.google.com/',
  ],
  { stdio: 'ignore' }
);

child.on('error', (err) => {
  console.error('Could not launch Chrome:', err.message);
  process.exit(1);
});

child.on('exit', () => {
  console.log('');
  console.log('Session saved to ./google-session.');
  console.log('You can now run: node bot.js "<meet-url>"');
});