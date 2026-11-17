# Scam Hunter (3-hour hackathon build)

An AI that catches a phone scam mid-call, swaps grandma out for a stalling AI persona, then runs cleanup. The spec is `docs/SPEC.md`. Read it fully before coding and follow its timeline.

## Rules

- **3 hours total.** Simplest thing that works on stage. If something isn't in SPEC §1, don't build it. Respect the cut list in §3.
- Base the project on `twilio-samples/speech-assistant-openai-realtime-api-node` (Fastify, plain JS, ESM). Keep its OpenAI Realtime audio settings unchanged.
- Verify Twilio `<Transcription>` attribute and callback field names against current docs before writing the parser (SPEC §7.1).
- Work to the checkpoints at minute 60 and 100. At each one, tell me exactly how to test it on real phones.
- When something needs me (Twilio console, ngrok URL, keys, phones), stop and give a short checklist.
- No TypeScript, no frameworks for the dashboard, no database.

## Hard guardrails

- Only dial numbers from `.env` (`GRANDMA_PHONE`, `FAMILY_PHONE`); enforce in code.
- Never submit anything to a real bank, the FTC or police.
- Never commit `.env` or log secrets.

## Commands

- `npm start` — server
- `node scripts/replay.js fixtures/<name>.json` — replay a script through detector + dashboard
