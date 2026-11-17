// Usage: node scripts/replay.js fixtures/irs.json
// Feeds a fixture through the running server's detector + dashboard and prints what happens.
// The server must be running (npm start).
import { basename } from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const file = process.argv[2];
if (!file) {
    console.error('Usage: node scripts/replay.js fixtures/<name>.json');
    process.exit(1);
}
const name = basename(file, '.json');
const base = `localhost:${process.env.PORT || 5050}`;

let callSid = null;
let triggered = false;
const buffered = [];

function show(ev) {
    if (ev.callSid !== callSid) return;
    if (ev.type === 'utterance') console.log(`  ${ev.speaker.padEnd(8)} ${ev.text}`);
    if (ev.type === 'score') console.log(`    -> score ${ev.score} [${ev.signals.join(', ')}] ${ev.reason}`);
    if (ev.type === 'incident') console.log('INCIDENT', ev.summary, ev.intel);
    if (ev.type === 'action' && ev.status !== 'running') console.log(`ACTION ${ev.kind}: ${ev.status}\n${ev.detail}`);
    if (ev.type === 'state') {
        console.log(`STATE ${ev.state}`);
        if (ev.state === 'takeover') triggered = true;
        if (ev.state === 'ended' && !triggered) finish();
    }
    if (ev.type === 'action' && ev.kind === 'report_draft' && ev.status !== 'running') finish();
}

function finish() {
    console.log(triggered ? '\nRESULT: TRIGGERED (takeover)' : '\nRESULT: did not trigger');
    process.exit(0);
}

const ws = new WebSocket(`ws://${base}/dashboard`);
ws.onerror = () => {
    console.error(`Could not reach the server at ${base}. Is "npm start" running?`);
    process.exit(1);
};
ws.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (callSid) show(ev);
    else buffered.push(ev);
};
ws.onopen = async () => {
    const res = await fetch(`http://${base}/api/replay/${name}`, { method: 'POST' });
    if (!res.ok) {
        console.error(`Replay failed: ${res.status} ${await res.text()}`);
        process.exit(1);
    }
    ({ callSid } = await res.json());
    console.log(`Replaying ${name} as ${callSid}`);
    buffered.forEach(show);
};
