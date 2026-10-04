# Meet Transcript Bot — the fully free path

No Vexa, no self-hosted Docker stack, no per-minute transcription cost, no
paid hosted credits. This joins a Google Meet as **you** (your real Google
account, logged in once), turns on Meet's own free live captions, and saves
them as a transcript. Google's captions ARE the transcription step — nothing
else needs to run for that part.

The only unavoidable cost anywhere in the pipeline is the Claude API call
that turns the transcript into a summary/decisions/action-items — a few
cents per meeting, metered per token.

## Why this is lighter than the Vexa build that kept failing

The whole reason the self-hosted Vexa build kept dying on your connection is
that it needed to download gigabytes across dozens of registries and
hundreds of npm packages. This needs exactly one real download: Playwright's
bundled Chromium browser (a few hundred MB, one file, one registry) — nothing
close to the multi-hour, multi-thousand-request ordeal from before.

## Setup

```
cd meet-transcript-bot
npm install
npx playwright install chromium
```

If `npx playwright install chromium` also struggles on your connection, run
it again — it's one file, so plain retries are actually appropriate here
(unlike the Vexa build, there's no huge dependency tree behind it).

## One-time login

```
node login.js
```

A real browser window opens. Log into your Google account normally, then
just close the window. Your session is saved to `google-session/` so future
runs join meetings as you without logging in again.

## Join a meeting and capture its transcript

```
node bot.js "https://meet.google.com/xxx-xxxx-xxx"
```

A visible browser window joins the meeting, turns on captions, and prints
each caption line to your terminal as it's captured. When you leave the
call (or press Ctrl+C), it writes `transcript.json` in this folder:

```json
{
  "meeting_id": "xxx-xxxx-xxx",
  "participants": ["Alice", "Bob"],
  "raw_transcript_text": "Alice: Let's start with...\nBob: Sounds good...",
  "started_at": "2026-09-14T18:00:00.000Z",
  "ended_at": "2026-09-14T18:41:00.000Z"
}
```

That's exactly the contract shape from the runbook (Step 07), so it plugs
straight into the rest of the pipeline unchanged.

## Importing the ready-made n8n pipeline

`n8n-workflow.json` in this folder is a ready-to-import workflow:

```
Webhook (meet-transcript) → Build Mistral Request → Call Mistral API → Parse Mistral Response → Respond to Webhook
```

1. In n8n: **Workflows → Import from File** → select `n8n-workflow.json`.
2. Open the **Call Mistral API** node and set its credential: create an
   **HTTP Header Auth** credential with header name `Authorization` and
   value `Bearer <your Mistral API key>`, then select it in the node.
3. Activate the workflow and copy the Webhook's **Production URL**.
4. Run the bot with that URL as the third argument — when the meeting
   ends, the bot POSTs the transcript, n8n asks Mistral for a report, and
   the bot saves the reply as `report.md` next to `transcript.json`.

### Adding documents shared in the meeting (Word / Excel / PowerPoint / PDF)

The bot extracts the text of these files itself (n8n can't read
`.docx`/`.pptx`) and sends it in the same request as the transcript, so
the report uses both sources. No files = transcript only.

**Easiest way:** copy the files into the `documents/` folder of this
project, before or during the meeting. When you leave the call the bot reads
everything in that folder, then moves it to `documents/archive/` so the
next meeting starts clean.

**Or** pass files explicitly with `--file` (as many as you like):

```
node bot.js "https://meet.google.com/xxx-xxxx-xxx" transcript.json https://<n8n-host>/webhook/meet-transcript --file slides.pptx --file budget.xlsx
```

Supported: `.docx .pptx .xlsx .odt .odp .ods .pdf .txt .md .csv .json`.
Each document is capped at 30,000 characters.

## Wiring it into n8n (Steps 08–09 from the runbook, unchanged)

Two ways to hand the transcript to n8n:

**Option A — n8n picks up the file.** Point a "Local File Trigger" node (or
a Watch Folder step) at this project's folder for new `transcript*.json`
files, then feed the file straight into the Claude HTTP Request node from
Step 08.

**Option B — the bot posts it directly (no polling).** Add an n8n
**Webhook** node, copy its Production URL, and pass it as a third argument:
```
node bot.js "https://meet.google.com/xxx-xxxx-xxx" transcript.json https://<your-n8n-host>/webhook/meet-transcript
```
The bot POSTs the finished JSON straight to that webhook the moment the
meeting ends — the webhook node's output already matches Step 07's shape,
so it connects directly into Claude analysis (Step 08) and report delivery
(Step 09) with zero glue code.

## Running it automatically for every meeting

Pair this with the same Google Calendar Trigger node from Step 04 of the
runbook: instead of it calling Vexa's `/bots` endpoint, have it run this
script for you (an n8n **Execute Command** node calling
`node bot.js "<meet-link-from-the-calendar-event>" transcript.json <webhook>`
on a schedule/trigger) whenever a meeting is about to start.

## Known limits (same honesty as the rest of the runbook)

- Caption quality is Google's own live-caption ASR — good, but not as clean
  as Whisper/Voxtral on a clean audio file, and speaker labels aren't always
  present.
- Meet's DOM changes over time. If captions stop being captured, open
  DevTools on the captions panel (right-click → Inspect) and check whether
  `[aria-label="Captions"]` still matches — update the selector in `bot.js`
  if not.
- The bot joins as a visible participant under your account, which is good
  for consent transparency — everyone on the call can see it's there.
- The browser window needs to stay open (not minimized to nothing, and the
  machine needs to stay awake) for the whole meeting.
