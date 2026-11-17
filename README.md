# Scam Hunter

Scam Hunter catches a phone scam mid-call, swaps Grandma out for an AI that keeps the scammer talking, and has Fo text her family that she's safe.

Built in a hackathon for the Wajo Fo track.

## What happens in a call

1. A caller rings Grandma Rose. The dashboard shows the caller's words live.
2. An AI scores every sentence from 0 to 100. The score rises when the caller pretends to be an official, makes threats, asks for secrecy, or asks for gift cards, codes or account details.
3. When the score reaches 80 (or two strong warning signs have been seen), Scam Hunter takes Grandma off the call. An AI voice called Rose takes over and stalls the caller.
4. At that same moment, the server asks Fo to text Grandma's family that she was targeted and is safe.
5. When the caller hangs up, the dashboard shows a summary of what the caller claimed and wanted, and a fraud report draft. The draft is never submitted anywhere.

## How it works

| Piece | What it does |
| --- | --- |
| `index.js` | Fastify server: call state, takeover, cleanup, and the audio bridge to the AI voice |
| `llm.js` | Scam detector and incident summary (OpenAI chat model, JSON output) |
| `fo.js` | Sends requests to Fo through Wajo's MCP server and follows them until Fo is done |
| `public/dashboard.html` | Live dashboard: transcript, score, takeover banner, Fo panel, cleanup checklist |
| `public/call.html` | A web page that acts as the caller's phone |
| `scripts/replay.js`, `fixtures/` | Replays a saved script through the detector and dashboard |
| `scripts/fo-login.js` | One-time login so the server can talk to Fo |

Rose's voice is the OpenAI Realtime API. The server started from Twilio's sample [`speech-assistant-openai-realtime-api-node`](https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node).

There are two ways to place the call:

- **Browser call (the one we demo).** The caller opens `/call` and talks into it. No phone network and no telephony account are needed. Before the takeover the AI session only transcribes the caller; at the takeover Rose starts speaking on the same stream.
- **Twilio phone call.** A real number rings Grandma's real phone, Twilio transcribes the caller, and the takeover redirects the call to Rose. This path is written but has never carried a real call, so treat it as untested.

## Setup

Requires Node.js 20 or later.

```
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Needed for | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | everything | Needs Realtime API access |
| `DETECTOR_MODEL` | everything | A small chat model that supports JSON mode |
| `REALTIME_MODEL` | Rose | Defaults to `gpt-realtime` |
| `FAMILY_PHONE` | Fo alert | The number Fo texts, as `+1…` |
| `FO_MODE` | Fo alert | `mock` sends nothing; `real` sends the text through Fo |
| `PORT` | optional | Defaults to 5050 |
| `TWILIO_*`, `GRANDMA_PHONE`, `PUBLIC_HOST` | Twilio calls only | Not needed for the browser call |

To let the server use Fo, log in once. Your own phone number must also be linked in your Wajo settings, or Fo will not send texts.

```
node scripts/fo-login.js
```

The login is saved to `.fo-auth.json`, which is not committed.

## Run it

```
npm start
```

- **Dashboard:** `http://localhost:5050/`
- **Caller's phone:** `http://localhost:5050/call` on the same machine. On another device, run `ngrok http 5050` and open `https://<your ngrok host>/call`, because browsers only allow the microphone on a secure address.

Tap Call, allow the microphone, and speak as the caller. A script that triggers the takeover:

> "Hello, this is Officer Morgan with the IRS."
> "You owe three thousand dollars, and there is a warrant for your arrest."
> "Go buy gift cards today and read me the numbers."

Fo takes 45 to 60 seconds to send its text, so stay on the call with Rose for about a minute.

### Without a microphone

Press **Replay IRS** on the dashboard, or run:

```
node scripts/replay.js fixtures/irs.json        # should trigger the takeover
node scripts/replay.js fixtures/pharmacy.json   # a normal call; should not trigger
```

Replays never contact Fo or call anyone.

### With Twilio

Point the number's "A call comes in" webhook at `POST https://<host>/incoming` and "Call status changes" at `POST https://<host>/status`. A trial account plays a message first and only rings verified numbers.

## Guardrails

- The server only ever contacts `GRANDMA_PHONE` and `FAMILY_PHONE` from `.env`. This is enforced in code.
- Fo is asked to text one number and told not to contact anyone else.
- Nothing is sent to a bank, the FTC or the police. The fraud report is a draft on screen.
- A detector error never triggers a takeover; the dashboard tells the operator to use the **Take over** button.
- Only use this with people who have agreed to be on the call.

## Known limits

- On a browser call, Grandma is a person in the room, and her words are not shown on the dashboard.
- If Rose's voice leaks from the speaker back into the microphone, she can interrupt herself. Earbuds, or holding the phone to the ear, avoids it.
- If Fo stops to ask a question, nobody can answer it from the dashboard and the alert shows as failed.
- The takeover can land one sentence earlier or later from run to run.
- Call state lives in memory. Restarting the server clears it.

## More

- `SPEC.md`: the original 3-hour build plan.
- `PRODUCT.md`: who the dashboard is for and what it must make clear.
