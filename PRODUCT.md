# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hackathon judges and audience watching a roughly 2-minute live demo on a projector, often from the back of a room. They only watch. A teammate at the laptop presses the two buttons ("Take over", "Replay IRS") and, if needed, copies the Fo task.

The people inside the story (grandma, her family) do not use the dashboard.

## Product Purpose

Scam Hunter catches a phone scam while the call is in progress, removes grandma from the call, puts an AI persona ("Grandma Rose") on the line to stall the scammer, then runs cleanup once the call ends.

Success is a demo that an audience follows without narration: they see the caller's words, see why the call was judged a scam, see the moment grandma is swapped out, and see the follow-up happen.

## Positioning

It acts mid-call. Scam Hunter does not just warn: it takes grandma off the call and keeps the scammer busy with an AI. That moment of takeover is the thing the dashboard must make unmistakable; detection leads up to it and cleanup follows from it.

## Operating Context

- Shown on a projector at a hackathon, driven from one laptop, with three real phones (scammer, grandma, family) on stage.
- A real call is the main path. "Replay IRS" plays a saved script through the same detector and dashboard as a fallback.
- Call states, in order: ringing, live, takeover, ended.
- After the call: incident summary and scam intel, a voice-call alert to the family phone, a Fo task ready to send, and a fraud report draft.

## Capabilities and Constraints

- The dashboard shows: live transcript (caller, grandma, Rose), a 0-100 scam score with signal chips and a short reason, a takeover banner, scam intel, a cleanup checklist, and the Fo task with a Copy button.
- Signals: impersonation, unusual payment, code or remote access (strong); urgency or threat, secrecy (medium).
- On a real call only the caller's side is transcribed before takeover, so grandma's own words do not appear. They do appear in replays.
- The fraud report is a draft on screen and is never submitted. Nothing is sent to a real bank, the FTC or the police.
- Stack is fixed by the existing code: Fastify server in plain JavaScript, a dashboard in `public/dashboard.html` using vanilla JS and a WebSocket. No TypeScript, no framework, no database.
- The whole project is a 3-hour build; `SPEC.md` holds the scope and the cut list.
- Undecided: whether the Fo task is sent for real (depends on Wajo granting access) or pasted into Fo by a teammate on stage.

## Brand Commitments

- The Wajo / Fo tie-in must stay visible: the Fo task is the sponsor connection and keeps a prominent place on the dashboard.
- Working names in use: "Scam Hunter", "Grandma Rose", and the header "Grandma Rose — protected". These were not confirmed as fixed.

## Evidence on Hand

- `fixtures/irs.json`: an IRS gift-card scam script that should trigger takeover.
- `fixtures/pharmacy.json`: a normal pharmacy call that should not.
- No logo, brand assets, testimonials, user data or metrics exist. Do not invent any.

## Product Principles

1. The takeover is the climax. Everything before builds to it and everything after follows from it.
2. Legible at a distance and at a glance; the audience gets one viewing.
3. Show the reason, not just the verdict: the signals and the caller's own words justify the takeover.
4. Never imply a real-world action that did not happen (report submitted, bank contacted).
5. Stage reliability beats features.

## Accessibility & Inclusion

Must be readable from the back of a room on a projector, which can wash out contrast. No formal standard was set.
