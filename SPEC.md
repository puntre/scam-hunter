# Scam Hunter — 3-Hour Build Spec

Hard limit: 3 hours. Ship the demo flow, nothing else. Build in the order below and do not polish until Checkpoint 2 passes.

## 1. The demo we must ship

1. A teammate ("scammer") calls our Twilio number. It rings grandma's real phone; they talk.
2. The dashboard shows the scammer's words live and a scam score with reasons.
3. When the score triggers (or someone clicks "Take over"), grandma's line drops and an AI voice, "Grandma Rose", continues the call and stalls the scammer.
4. When the call ends: an incident summary and scam intel appear, the family phone gets a voice-call alert, and a ready-to-send Fo task is shown (sent for real only if Wajo gives us access).

## 2. Shortcuts (why this fits in 3 hours)

- **Start from Twilio's sample repo** `twilio-samples/speech-assistant-openai-realtime-api-node`. It already proxies a Twilio call to the OpenAI Realtime API with Fastify. We add routes around it.
- **No audio handling for transcription.** Use Twilio Real-Time Transcription (`<Start><Transcription>`), which posts transcript events to a webhook. No Deepgram, no audio decoding.
- **Takeover = one API call.** Grandma is connected with a plain `<Dial>`. To take over, update the scammer's call with new TwiML (`<Connect><Stream>` to the AI). Redirecting the parent call ends the `<Dial>`, so grandma's leg drops automatically. No conference, no participants API, no TwiML App.
- **Dashboard = one static HTML file** with vanilla JS and a WebSocket. No React, no build step.
- **Plain JavaScript (ESM)**, matching the sample repo.

## 3. Cut list (do NOT build)

Conference calls, announcement to grandma, Deepgram, React/Vite, database, auth, SMS, multilingual callback, detector eval suite, real bank/FTC anything.

## 4. Environment

```
PUBLIC_HOST=xxxx.ngrok-free.app
PORT=5050
OPENAI_API_KEY=
DETECTOR_MODEL=            # small fast chat model
REALTIME_MODEL=            # whatever the sample repo uses
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_NUMBER=+1...
GRANDMA_PHONE=+1...
FAMILY_PHONE=+1...
FO_MODE=mock               # mock | real
```

## 5. Human setup (first 15 minutes; Claude Code cannot do these)

1. Twilio account **upgraded from trial** (trial plays a "press any key" prompt and only reaches verified numbers). One voice number.
2. `ngrok http 5050`; set the number's Voice webhook to `POST https://PUBLIC_HOST/incoming`.
3. OpenAI key with Realtime access.
4. Three phones: scammer, grandma, family. Use a phone hotspot, not venue Wi-Fi.

## 6. Routes to add

| Route | What it does |
| --- | --- |
| `POST /incoming` | Returns the TwiML in §7.1. Creates call state keyed by `CallSid`. |
| `POST /transcripts` | Twilio Real-Time Transcription callback. On `transcription-content` with a final utterance: store it, emit to dashboard, run detector. |
| `POST /api/takeover/:callSid` | Manual takeover (dashboard button). |
| `POST /status` | Call status callback. On `completed`: run cleanup. |
| `WS /media-stream` | Existing sample handler, modified: Rose persona + transcript context (§8). |
| `WS /dashboard` | Pushes events to the dashboard. |
| `GET /` | Serves `public/dashboard.html`. |

## 7. Call flow

### 7.1 Incoming call TwiML

```xml
<Response>
  <Start>
    <Transcription statusCallbackUrl="https://PUBLIC_HOST/transcripts" track="inbound_track" partialResults="false"/>
  </Start>
  <Dial>GRANDMA_PHONE</Dial>
</Response>
```

- `inbound_track` on the scammer's call = the scammer's voice only, so every transcript line is the scammer. That's all the detector needs.
- Set the call's status callback (Twilio console, or `statusCallback` when possible) to `https://PUBLIC_HOST/status`.
- **Verify in Twilio's current `<Transcription>` docs**: the attribute names (`track`, `partialResults`), the callback event names, and where the text sits in the payload (`TranscriptionData` JSON). Adjust before coding the parser.

### 7.2 Takeover

```js
await twilio.calls(callSid).update({
  twiml: `<Response><Connect><Stream url="wss://${PUBLIC_HOST}/media-stream"><Parameter name="callSid" value="${callSid}"/></Stream></Connect></Response>`
});
```

- This drops grandma's `<Dial>` leg and connects the scammer to the AI.
- Read `callSid` from the stream's `start` event `customParameters` to find the transcript so far.
- Check whether the `<Start><Transcription>` keeps running after the redirect. If it stops, use the Realtime API's input-audio transcription events for the scammer's words and the model's response transcript for Rose's words.
- Guard: take over at most once per call.

### 7.3 States

`ringing → live → takeover → ended`, emitted to the dashboard on every change.

## 8. Rose persona (`/media-stream`)

Modify the sample's session setup:

- System prompt: warm, slow, hard of hearing, mishears numbers, short tangents (cat, knitting). Keep the caller talking. Try to learn their callback number, the agency they claim and the exact payment instructions. Never give a real name, address, card number, account number or code; if pushed, read wrong digits slowly and lose your place. Never threaten or insult. Turns of 1–2 sentences.
- Append "Here is what the caller said so far:" plus the stored transcript.
- Right after the session is ready, make Rose speak first: "Sorry dear, I dropped the phone. Who did you say this was?"
- Emit Rose's and the scammer's lines to the dashboard as `utterance` events.
- **Keep the sample's audio format settings as they are** (μ-law 8 kHz). Only change instructions, voice and the first message.

## 9. Detector

On each final scammer line, call `DETECTOR_MODEL` with the last ~8 lines; require JSON:

```json
{"signals": ["impersonation"], "score": 0, "reason": "short phrase"}
```

Signals: `impersonation`, `unusual_payment` (gift cards, crypto, wire, payment app), `code_or_remote_access` (strong); `urgency_or_threat`, `secrecy` (medium).

**Trigger:** two different strong signals seen in the call so far, or score ≥ 80. Errors never trigger; keep the last score.

Quick test: `node scripts/replay.js fixtures/irs.json` feeds a saved script line by line (2 s apart) through the detector and dashboard. Make two fixtures: one IRS gift-card scam (must trigger), one normal call from a pharmacy (must not).

## 10. Cleanup (on call `completed`)

1. One LLM call: transcript → `{summary, claimedAgency, paymentMethod, callbackNumber, amountRequested}`; emit `incident`.
2. Family alert: Twilio call to `FAMILY_PHONE` with `<Say>`: "Scam Hunter stopped a scam call to Grandma Rose. Someone claiming to be {agency} asked for {payment}. She is safe." (Voice, not SMS: SMS from US numbers needs A2P registration.)
3. Fo task: build the text a family member would send Fo ("Call Grandma Rose's bank at … and flag her card; she received a scam call from … asking for …"). Show it on the dashboard with a Copy button. If `FO_MODE=real` and Wajo gave us an endpoint, send it; otherwise a teammate pastes it into Fo live on stage.
4. Fraud report: show a pre-filled draft only. **Never submit.**

Emit an `action` event for each step: `running` → `done`/`failed`.

## 11. Dashboard (`public/dashboard.html`)

One page, readable from the back of a room, dark background, big type:

- Header: "Grandma Rose — protected" + state pill.
- Left: transcript (scammer red, grandma grey, Rose blue).
- Right: score meter 0–100 + signal chips + reason; scam-intel panel; cleanup checklist; Fo task box with Copy button.
- Full-width red **SCAM DETECTED** banner on takeover.
- Buttons: "Take over" (manual) and "Replay IRS" (runs the fixture).

Events (server → page):

```js
{type:"state", callSid, state}
{type:"utterance", callSid, speaker:"scammer"|"grandma"|"rose", text}
{type:"score", callSid, score, signals, reason}
{type:"incident", callSid, summary, intel:{...}}
{type:"action", callSid, kind:"family_alert"|"fo_task"|"report_draft", status, detail}
```

## 12. Timeline (180 minutes)

| Minutes | Do | Done when |
| --- | --- | --- |
| 0–15 | Human setup (§5); clone sample repo; run it unchanged | Calling the number reaches the sample AI |
| 15–60 | `/incoming` with transcription + `<Dial>` grandma; `/transcripts`; detector; dashboard shell; replay script | Replay shows transcript + score; normal fixture stays low |
| **60** | **Checkpoint 1** | A real call: scammer's words + score live on the dashboard |
| 60–100 | Takeover (manual button first, then automatic); Rose persona with context | Grandma drops, Rose talks |
| **100** | **Checkpoint 2** | Full flow with no button presses. Record the backup video NOW |
| 100–130 | Cleanup: incident + intel, family call, Fo task box, report draft | Checklist ticks off after hang-up |
| 130–160 | Polish the dashboard, tune Rose's lines, rehearse 3 times | 2-minute demo runs clean |
| 160–180 | Buffer. Code freeze at 170 | — |

If Checkpoint 1 slips past 75 minutes, drop automatic takeover and use the button on stage. If Checkpoint 2 slips past 120, drop the family call and show cleanup on screen only.

## 13. Guardrails

- Only dial `GRANDMA_PHONE` and `FAMILY_PHONE` from `.env`; enforce in code.
- No real scam numbers, banks, FTC or police. Report = draft on screen.
- Everyone on demo calls is a consenting teammate.
- Never commit `.env` or log keys.
