// Usage: node bot.js "<google-meet-url>" [output.json] [webhookUrl]
//
// Joins the given Google Meet as your logged-in Google account (run
// `node login.js` once first), turns on live captions, and captures them
// as a transcript for free — no Vexa, no Whisper/Voxtral, no self-hosted
// Docker stack, no per-minute API cost. Google's own captions are doing
// the transcription; this script just reads them off the screen.
//
// Output matches the pipeline's standard contract:
//   { meeting_id, participants, raw_transcript_text, started_at, ended_at }
//
// Caveats (same ones discussed in the runbook): caption text can be lower
// quality than a real ASR model, speaker labels depend on Meet showing a
// name on the caption line, and Meet's DOM can change — if the caption
// panel selector below stops matching, right-click the captions area in
// Chrome DevTools ("Inspect") to find the current one.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const USER_DATA_DIR = path.join(__dirname, 'google-session');

// Positional args as before, plus any number of `--file <path>` options
// (Word/Excel/PowerPoint/PDF/text shared in the meeting) whose text gets
// sent along with the transcript so the LLM can use both sources.
const positional = [];
const filePaths = [];
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--file' && rawArgs[i + 1]) filePaths.push(rawArgs[++i]);
  else positional.push(rawArgs[i]);
}

const meetUrl = positional[0];
const outputPath = positional[1] || 'transcript.json';
const webhookUrl = positional[2] || process.env.N8N_WEBHOOK_URL || null;
const reportPath = path.join(path.dirname(path.resolve(outputPath)), 'report.md');

if (!meetUrl) {
  console.error('Usage: node bot.js "<google-meet-url>" [output.json] [webhookUrl] [--file <document>]...');
  process.exit(1);
}

const MAX_DOC_CHARS = 30000; // keep the LLM prompt a sane size per document

// Files shared in the meeting can simply be dropped into ./documents at any
// time (even mid-meeting) — they're read when the call ends, then archived.
const DOCS_DIR = path.join(__dirname, 'documents');
const SUPPORTED_EXTS = ['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.pdf', '.txt', '.md', '.csv', '.json'];

function listDroppedFiles() {
  try {
    return fs
      .readdirSync(DOCS_DIR, { withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() &&
          !e.name.startsWith('~$') && // Office lock files for documents still open
          !e.name.startsWith('.') &&
          SUPPORTED_EXTS.includes(path.extname(e.name).toLowerCase())
      )
      .map((e) => path.join(DOCS_DIR, e.name));
  } catch (_) {
    return [];
  }
}

// n8n can't read .docx/.pptx itself, so the text is extracted here.
async function loadDocuments(paths) {
  const documents = [];
  for (const p of paths) {
    try {
      const ext = path.extname(p).toLowerCase();
      let text;
      if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
        text = fs.readFileSync(p, 'utf8');
      } else if (['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.pdf'].includes(ext)) {
        text = await require('officeparser').parseOfficeAsync(p);
      } else {
        console.warn(`Skipping ${p}: unsupported file type "${ext}".`);
        continue;
      }
      text = (text || '').trim();
      if (!text) {
        console.warn(`Skipping ${p}: no text could be extracted.`);
        continue;
      }
      if (text.length > MAX_DOC_CHARS) {
        console.warn(`${path.basename(p)} is long — keeping the first ${MAX_DOC_CHARS} characters.`);
        text = text.slice(0, MAX_DOC_CHARS);
      }
      documents.push({ name: path.basename(p), text });
      console.log(`Loaded document: ${path.basename(p)} (${text.length} chars)`);
    } catch (err) {
      console.warn(`Could not read ${p}: ${err.message}`);
    }
  }
  return documents;
}

function meetingIdFromUrl(url) {
  const m = url.match(/meet\.google\.com\/([a-z0-9-]+)/i);
  return m ? m[1] : url;
}

// Playwright refuses to launch a persistent context while Chrome still holds
// the profile's singleton lock (e.g. a previous run's window is still open
// in the background). We only ever touch OUR dedicated automation profile
// here (google-session/), never the user's real Chrome profile, so it's
// safe to clear a stale lock — unlike `taskkill /F /IM chrome.exe`, this
// can't close windows the user is actually using elsewhere.
function clearStaleProfileLock() {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(USER_DATA_DIR, name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {
      /* best-effort */
    }
  }
}

// A leftover window from a previous login.js/bot.js run keeps the profile's
// Chrome instance alive, so a fresh launch just gets redirected into it
// ("Opening in existing browser session") instead of getting Playwright's
// own controllable process. Find and close ONLY chrome.exe processes whose
// command line references this exact dedicated profile directory — never a
// blanket taskkill, so the user's regular Chrome windows are untouched.
function killStaleProfileProcesses() {
  if (process.platform !== 'win32') return;
  try {
    // execFileSync (no shell) so the profile path never has to survive a
    // cmd.exe -> PowerShell double-quoting round trip; passed via env var
    // instead of being interpolated into the script text at all.
    const psScript =
      "$dir = $env:BOT_PROFILE_DIR; " +
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
      stdio: 'ignore',
      env: { ...process.env, BOT_PROFILE_DIR: USER_DATA_DIR },
    });
  } catch (_) {
    /* none running, or powershell unavailable — fine, launch will surface any real error */
  }
}

async function main() {
  if (!fs.existsSync(USER_DATA_DIR)) {
    console.error('No saved Google session found. Run "node login.js" once first.');
    process.exit(1);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --file documents are read up front so a bad path shows up now, not
  // after the meeting is over.
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const cliDocuments = await loadDocuments(filePaths);
  console.log(`Documents shared in the meeting? Drop them in ${DOCS_DIR} — they are read when you leave the call.`);

  const launchOptions = {
    headless: false, // headed is more reliable for Meet's join flow
    channel: 'chrome', // must match login.js — same real Chrome, same saved session
    args: ['--use-fake-device-for-media-stream'],
    permissions: ['microphone', 'camera'],
  };

  // Killing a stale Chrome process doesn't instantly release its file locks
  // on the profile directory — a launch attempted immediately after can
  // still find it transiently "in use" and get silently redirected into a
  // session that's already dying. That dying session can accept the launch
  // and even hand back a context/page, then close under us moments later —
  // so the retry has to cover the initial navigation too, not just launch().
  // Meet keeps rewriting/growing the SAME caption block for as long as one
  // person keeps talking (it only starts a new block after a real pause or
  // speaker change) — so each "line" must be tracked by a stable id and
  // updated in place, never appended as a new entry, or the transcript ends
  // up with the same growing sentence repeated dozens of times. Map
  // preserves insertion order, so iterating it later gives lines in the
  // order each speaker turn first started.
  const linesById = new Map(); // id -> { speaker, text }
  const participants = new Set();
  let context;
  let page;
  let domDumped = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    killStaleProfileProcesses();
    clearStaleProfileLock();
    if (attempt > 1) await sleep(2000);
    try {
      context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
      page = await context.newPage();

      // Receives caption updates pushed from inside the page, keyed by a
      // stable per-block id — update the existing line in place if we've
      // seen this id before, otherwise start a new one. This is what keeps
      // one continuous turn of speech as ONE transcript line instead of a
      // growing pile of near-duplicates.
      await page.exposeFunction('__onCaptionLine', (id, speaker, text) => {
        if (!text) return;
        if (speaker) participants.add(speaker);
        const existing = linesById.get(id);
        if (existing) {
          existing.text = text;
          if (speaker) existing.speaker = speaker;
        } else {
          linesById.set(id, { speaker: speaker || 'unknown', text });
        }
        console.log(`[caption] ${speaker || 'unknown'}: ${text}`);
      });

      // Speaker-name detection is a guess at Meet's (frequently-obfuscated,
      // locale-dependent) DOM structure. Dump the real markup around the
      // first caption line once, so the exact structure can be inspected
      // and the selector below corrected with certainty instead of
      // guessing blind.
      await page.exposeFunction('__onDebugCaptionDom', (html) => {
        if (domDumped) return;
        domDumped = true;
        try {
          fs.writeFileSync(path.join(__dirname, 'debug-captions-dom.html'), html);
          console.log('Saved debug-captions-dom.html — the real captions markup, for fixing speaker-name detection.');
        } catch (_) {
          /* ignore */
        }
      });

      console.log('Joining meeting:', meetUrl);
      await page.goto(meetUrl, { waitUntil: 'domcontentloaded' });
      break; // launch + navigation both succeeded
    } catch (err) {
      try {
        await context?.close();
      } catch (_) {
        /* already gone — fine */
      }
      if (attempt === 2) throw err;
      console.warn('Browser launch/navigation failed, retrying after cleanup:', err.message);
    }
  }

  const startedAt = new Date().toISOString();

  // Google Meet's UI language follows the Google account's language setting
  // (this account is French), so every button label below needs the FR text
  // alongside the EN one — an aria-label selector alone silently fails when
  // the account isn't in English.

  // Mute mic / turn off camera on the pre-join screen if the buttons are present
  // (best-effort — ignore if Meet's layout doesn't show them for this account).
  const preJoinMuteButtons = [
    'button[aria-label*="Turn off microphone" i]',
    'button[aria-label*="Désactiver le micro" i]',
    'button[aria-label*="Turn off camera" i]',
    'button[aria-label*="Désactiver la caméra" i]',
  ];
  for (const sel of preJoinMuteButtons) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 })) await btn.click();
    } catch (_) {
      /* not present — fine */
    }
  }

  // Click whichever join button Meet shows (host vs guest wording differs,
  // language varies by account, and Google renames these periodically — cast
  // a wide net with one combined locator so we wait once for whichever shows
  // up, instead of a fixed timeout per candidate).
  const joinButtonSelector = [
    'button:has-text("Join now")',
    'button:has-text("Ask to join")',
    'button:has-text("Join meeting")',
    'button:has-text("Rejoindre maintenant")',
    'button:has-text("Demander à participer")',
    'button:has-text("Rejoindre")',
    '[role="button"]:has-text("Join now")',
    '[role="button"]:has-text("Ask to join")',
    '[role="button"]:has-text("Rejoindre maintenant")',
    '[role="button"]:has-text("Demander à participer")',
  ].join(', ');
  let joined = false;
  try {
    const btn = page.locator(joinButtonSelector).first();
    await btn.waitFor({ state: 'visible', timeout: 30000 });
    const label = await btn.textContent();
    await btn.click();
    joined = true;
    console.log(`Clicked join button ("${label?.trim()}")`);
  } catch (_) {
    /* handled below */
  }
  if (!joined) {
    console.warn('Could not find a Join/Ask-to-join button automatically — click it yourself in the window.');
    try {
      await page.screenshot({ path: path.join(__dirname, 'debug-prejoin.png'), fullPage: true });
      console.warn('Saved a screenshot to debug-prejoin.png — inspect it to find the current selector.');
    } catch (_) {
      /* ignore */
    }
  }

  // Wait until we're actually in the call (the Leave-call button appears).
  // Meet has used a few different labels for this over time, in whichever
  // language the account uses ("Leave call" / "Quitter l'appel").
  console.log('Waiting to be let into the meeting (this may need a host to admit you, or a manual click if the button above wasn\'t found)...');
  const leaveButtonSelector = [
    'button[aria-label*="Leave call" i]',
    'button[aria-label*="Leave meeting" i]',
    'button[aria-label*="Quitter l\'appel" i]',
  ].join(', ');
  let inCall = false;
  try {
    await page.locator(leaveButtonSelector).first().waitFor({ timeout: 5 * 60 * 1000 });
    inCall = true;
  } catch (_) {
    /* handled below */
  }
  if (!inCall) {
    try {
      await page.screenshot({ path: path.join(__dirname, 'debug-notjoined.png'), fullPage: true });
      console.warn('Saved a screenshot to debug-notjoined.png.');
    } catch (_) {
      /* ignore */
    }
    throw new Error('Never detected entry into the meeting (no Leave-call button found within 5 minutes).');
  }
  console.log('In the meeting.');

  // Turn on captions. Google has used both "Turn on captions" and
  // "Turn on captions (c)" as the aria-label (or "Activer les sous-titres" /
  // "Activer les sous-titres (c)" in French); match loosely on "caption"/
  // "sous-titres" so wording tweaks don't break this.
  const captionSelectors = [
    'button[aria-label*="Turn on captions" i]',
    'button[aria-label*="caption" i]',
    'button[aria-label*="sous-titres" i]',
  ];
  let captionsOn = false;
  for (const sel of captionSelectors) {
    try {
      const ccButton = page.locator(sel).first();
      if (await ccButton.isVisible({ timeout: 5000 })) {
        await ccButton.click({ timeout: 10000 });
        captionsOn = true;
        console.log(`Captions turned on (matched: ${sel})`);
        break;
      }
    } catch (_) {
      /* try next */
    }
  }
  if (!captionsOn) {
    console.warn('Could not click the captions button automatically — turn on captions (CC icon) yourself.');
    try {
      await page.screenshot({ path: path.join(__dirname, 'debug-incall.png'), fullPage: true });
      console.warn('Saved a screenshot to debug-incall.png — inspect it to find the current selector.');
    } catch (_) {
      /* ignore */
    }
  }

  // Inject a MutationObserver on the captions region. It waits for a caption
  // line to stop changing for ~1s (captions rewrite themselves live as Meet's
  // speech recognition corrects itself) before treating it as final.
  await page.evaluate(() => {
    const STABLE_MS = 1000;
    const seen = new Map(); // element -> {text, timer}

    function findCaptionsRegion() {
      return (
        document.querySelector('[aria-label="Captions"]') ||
        document.querySelector('[aria-label="Sous-titres"]') ||
        document.querySelector('[jsname][aria-live="polite"]')
      );
    }

    let domDumpSent = false;

    function findSpeakerName(el, captionText) {
      // Meet groups each speaker's avatar/name with their running caption
      // line under a shared ancestor block. Walk up a few levels and look
      // for a short text label (or an avatar's alt text) that isn't the
      // caption text itself.
      let node = el;
      for (let depth = 0; depth < 4 && node; depth++) {
        node = node.parentElement;
        if (!node) break;
        const candidates = node.querySelectorAll('img[alt], [class*="name" i], [data-self-name], span, div');
        for (const c of candidates) {
          if (c.contains(el) || el.contains(c)) continue; // skip the caption element's own subtree/ancestry
          const t = (c.getAttribute?.('alt') || c.innerText || '').trim();
          if (t && t.length > 0 && t.length <= 40 && t !== captionText) {
            return t;
          }
        }
      }
      return null;
    }

    let nextLineId = 1;
    const lineIdByElement = new WeakMap(); // el -> stable id, for as long as Meet keeps reusing this block

    function handleLine(el) {
      const text = el.innerText?.trim();
      if (!text) return;
      const prev = seen.get(el);
      if (prev && prev.timer) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        let id = lineIdByElement.get(el);
        if (id === undefined) {
          id = nextLineId++;
          lineIdByElement.set(el, id);
        }
        const speaker = findSpeakerName(el, text);
        window.__onCaptionLine(id, speaker, text);
        if (!domDumpSent) {
          domDumpSent = true;
          const block = el.closest('div')?.parentElement || el.parentElement || el;
          window.__onDebugCaptionDom(block.outerHTML);
        }
      }, STABLE_MS);
      seen.set(el, { text, timer });
    }

    const observer = new MutationObserver((mutations) => {
      const region = findCaptionsRegion();
      if (!region) return;
      // Each direct child of the region is typically one speaker's running line.
      region.querySelectorAll('div').forEach((div) => {
        if (div.children.length === 0 && div.innerText?.trim()) handleLine(div);
      });
    });

    const target = findCaptionsRegion() || document.body;
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    window.__stopCaptionObserver = () => observer.disconnect();
  });

  async function finish() {
    const endedAt = new Date().toISOString();

    // Map iteration preserves insertion order, i.e. the order each speaker
    // turn first started — merge adjacent turns from the same speaker (Meet
    // sometimes splits one continuous thought into a couple of blocks on a
    // short pause) into a single clean paragraph per turn.
    const orderedLines = Array.from(linesById.values());
    const mergedLines = [];
    for (const line of orderedLines) {
      const prev = mergedLines[mergedLines.length - 1];
      if (prev && prev.speaker === line.speaker) {
        prev.text = `${prev.text} ${line.text}`;
      } else {
        mergedLines.push({ ...line });
      }
    }

    const raw_transcript_text = mergedLines
      .map((l) => `${l.speaker}: ${l.text}`)
      .join('\n');

    const cliResolved = filePaths.map((p) => path.resolve(p));
    const droppedDocuments = await loadDocuments(
      listDroppedFiles().filter((p) => !cliResolved.includes(path.resolve(p)))
    );
    const documents = [...cliDocuments, ...droppedDocuments];

    const result = {
      meeting_id: meetingIdFromUrl(meetUrl),
      participants: Array.from(participants),
      raw_transcript_text,
      started_at: startedAt,
      ended_at: endedAt,
      documents, // [{ name, text }] — empty when no files were attached
    };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`Transcript saved to ${outputPath}`);

    if (webhookUrl) {
      try {
        console.log('Sending to n8n and waiting for the report (can take up to a minute)...');
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });
        console.log('Posted to n8n webhook, status:', res.status);
        const data = await res.json().catch(() => null);
        if (data && data.report) {
          fs.writeFileSync(reportPath, data.report);
          console.log(`Report saved to ${reportPath}`);
        }
        if (data && data.upload_url) {
          console.log(`Add the documents shared in the meeting (optional) here: ${data.upload_url}`);
        }
      } catch (err) {
        console.error('Could not reach webhook — the transcript is still safe in', outputPath, err.message);
      }
    }

    // Their text is already inside transcript.json, so move the dropped files
    // out of the way — otherwise the next meeting would pick them up again.
    if (droppedDocuments.length) {
      try {
        const archiveDir = path.join(DOCS_DIR, 'archive', `${result.meeting_id}-${Date.now()}`);
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const d of droppedDocuments) {
          fs.renameSync(path.join(DOCS_DIR, d.name), path.join(archiveDir, d.name));
        }
        console.log(`Documents archived to ${archiveDir}`);
      } catch (err) {
        console.warn('Could not archive the documents:', err.message);
      }
    }

    await context.close();
    process.exit(0);
  }

  // Finish when you leave the call (from the Meet UI, in whichever
  // language it's showing), or on Ctrl+C.
  process.on('SIGINT', finish);
  try {
    await page.locator(leaveButtonSelector).first().waitFor({ state: 'detached', timeout: 0 });
  } catch (_) {
    /* fall through to finish() */
  }
  await finish();
}

main().catch((err) => {
  console.error('Bot failed:', err);
  process.exit(1);
});