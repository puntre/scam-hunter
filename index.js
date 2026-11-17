import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import { readFile } from 'node:fs/promises';
import { detect, summarize, STRONG_SIGNALS } from './llm.js';

// Load environment variables from .env file
dotenv.config();

const {
    OPENAI_API_KEY,
    PUBLIC_HOST,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_NUMBER,
    GRANDMA_PHONE,
    FAMILY_PHONE,
    FO_MODE = 'mock',
    FO_ENDPOINT,
} = process.env;
const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime';

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `You are Rose, an 82-year-old grandmother on a phone call. The caller is a suspected scammer and your job is to keep them talking as long as possible.

How you talk: warm, slow, a little hard of hearing. You mishear numbers and ask for them again. You drift into short tangents about your cat Whiskers or your knitting. Every turn is 1-2 short sentences.

What you try to learn, one thing at a time: the number you should call them back on, which agency or company they say they are from, and the exact payment instructions (how, how much, where to send it).

Hard rules: never give a real name, address, card number, account number or code. If pushed for one, read made-up wrong digits slowly and lose your place. Never threaten or insult the caller. Never say you are an AI or that you suspect a scam.`;
const FIRST_LINE = 'Sorry dear, I dropped the phone. Who did you say this was?';
const VOICE = 'sage';
const TEMPERATURE = 0.8; // Controls the randomness of the AI's responses
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = ['error', 'session.created', 'session.updated'];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// ---------------------------------------------------------------------------
// Guardrail (SPEC §13): the only numbers this server may ever dial.
// ---------------------------------------------------------------------------
function allowedNumber(number) {
    if (!number || ![GRANDMA_PHONE, FAMILY_PHONE].includes(number)) {
        throw new Error('Refusing to dial a number that is not GRANDMA_PHONE or FAMILY_PHONE');
    }
    return number;
}

let twilioClient = null;
function getTwilio() {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error('Twilio credentials missing in .env');
    twilioClient ??= twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    return twilioClient;
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// ---------------------------------------------------------------------------
// Call state + dashboard events
// ---------------------------------------------------------------------------
const calls = new Map(); // callSid -> call
const dashboards = new Set(); // open dashboard sockets
let history = []; // events of the most recent call, replayed to dashboards that connect late

function emit(event) {
    history.push(event);
    if (history.length > 500) history.shift();
    const msg = JSON.stringify(event);
    for (const ws of dashboards) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

function newCall(callSid, extra = {}) {
    const call = {
        callSid,
        state: 'ringing',
        transcript: [], // {speaker, text}
        signals: new Set(),
        score: 0,
        reason: '',
        seq: 0,
        scoreSeq: 0,
        takenOver: false,
        twilioAfterTakeover: false, // does Twilio transcription keep running after the redirect?
        ...extra,
    };
    calls.set(callSid, call);
    history = [];
    emit({ type: 'state', callSid, state: call.state });
    return call;
}

function setState(call, state) {
    if (call.state === state) return;
    call.state = state;
    console.log(`[${call.callSid}] state -> ${state}`);
    emit({ type: 'state', callSid: call.callSid, state });
}

function addUtterance(call, speaker, text) {
    call.transcript.push({ speaker, text });
    emit({ type: 'utterance', callSid: call.callSid, speaker, text });
}

// Every final scammer line goes through here: store, show, score, maybe trigger.
async function handleScammerLine(callSid, text) {
    const call = calls.get(callSid) || newCall(callSid);
    if (call.state === 'ended') return;
    if (call.state === 'ringing') setState(call, 'live');
    addUtterance(call, 'scammer', text);

    const seq = ++call.seq;
    try {
        const result = await detect(call.transcript.slice(-8));
        result.signals.forEach((s) => call.signals.add(s));
        if (seq > call.scoreSeq) {
            call.scoreSeq = seq;
            // Once Rose is on the line the meter should not sag while she stalls.
            call.score = call.takenOver ? Math.max(call.score, result.score) : result.score;
            call.reason = result.reason;
        }
        emit({ type: 'score', callSid, score: call.score, signals: [...call.signals], reason: call.reason });

        const strongSeen = STRONG_SIGNALS.filter((s) => call.signals.has(s)).length;
        if (strongSeen >= 2 || result.score >= 80) await takeover(callSid);
    } catch (err) {
        // Errors never trigger; the last score stays on screen.
        console.error(`[${callSid}] detector error:`, err.message);
    }
}

// SPEC §7.2: redirect the scammer's call to the AI. Grandma's <Dial> leg drops on its own.
async function takeover(callSid) {
    const call = calls.get(callSid);
    if (!call || call.takenOver || call.state === 'ended') return false;
    call.takenOver = true; // at most once per call
    if (!call.replay) {
        try {
            await getTwilio().calls(callSid).update({
                twiml: `<Response><Connect><Stream url="wss://${call.host || PUBLIC_HOST}/media-stream"><Parameter name="callSid" value="${xmlEscape(callSid)}"/></Stream></Connect></Response>`,
            });
        } catch (err) {
            console.error(`[${callSid}] takeover failed:`, err.message);
            call.takenOver = false;
            return false;
        }
    }
    setState(call, 'takeover');
    return true;
}

function endCall(callSid) {
    const call = calls.get(callSid);
    if (!call || call.state === 'ended') return;
    setState(call, 'ended');
    if (call.takenOver) cleanup(call).catch((err) => console.error(`[${callSid}] cleanup error:`, err.message));
}

// ---------------------------------------------------------------------------
// Cleanup (SPEC §10). Runs once, only for calls that were taken over.
// ---------------------------------------------------------------------------
async function cleanup(call) {
    const { callSid } = call;
    const action = (kind, status, detail = '') => emit({ type: 'action', callSid, kind, status, detail });

    // 1. Incident summary + intel
    let incident = {
        summary: 'A suspected scam call was intercepted.',
        intel: { claimedAgency: 'unknown', paymentMethod: 'unknown', callbackNumber: 'unknown', amountRequested: 'unknown' },
    };
    try {
        incident = await summarize(call.transcript);
    } catch (err) {
        console.error(`[${callSid}] summary error:`, err.message);
    }
    emit({ type: 'incident', callSid, ...incident });
    const { claimedAgency, paymentMethod, callbackNumber, amountRequested } = incident.intel;
    const known = (v, fallback) => (v && v !== 'unknown' ? v : fallback);
    const agency = known(claimedAgency, 'an official agency');
    const payment = known(paymentMethod, 'money');

    // 2. Family alert: a voice call to FAMILY_PHONE
    action('family_alert', 'running');
    if (call.replay) {
        action('family_alert', 'done', 'Replay: family call skipped');
    } else {
        try {
            await getTwilio().calls.create({
                to: allowedNumber(FAMILY_PHONE),
                from: TWILIO_NUMBER,
                twiml: `<Response><Pause length="1"/><Say>Scam Hunter stopped a scam call to Grandma Rose. Someone claiming to be ${xmlEscape(agency)} asked for ${xmlEscape(payment)}. She is safe.</Say><Pause length="1"/><Say>Again: Grandma Rose is safe.</Say></Response>`,
            });
            action('family_alert', 'done', 'Calling the family phone now');
        } catch (err) {
            action('family_alert', 'failed', err.message);
        }
    }

    // 3. Fo task: text a family member would send Fo
    action('fo_task', 'running');
    const foText = `Call Grandma Rose's bank at [number on the back of her card] and flag her card; she received a scam call from someone claiming to be ${agency} asking for ${payment}${known(amountRequested, '') ? ` (${amountRequested})` : ''}. She did not give out any details.`;
    if (FO_MODE === 'real' && FO_ENDPOINT) {
        try {
            const res = await fetch(FO_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: foText }),
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`Fo responded ${res.status}`);
            action('fo_task', 'done', foText);
        } catch (err) {
            console.error(`[${callSid}] Fo send failed:`, err.message);
            action('fo_task', 'failed', foText);
        }
    } else {
        action('fo_task', 'done', foText);
    }

    // 4. Fraud report: a draft on screen only. Never submitted anywhere.
    action('report_draft', 'running');
    const draft = [
        'FRAUD REPORT DRAFT (not submitted)',
        `Date: ${new Date().toLocaleString()}`,
        `Type: phone impersonation scam`,
        `Caller claimed to be: ${claimedAgency}`,
        `Payment requested: ${paymentMethod}`,
        `Amount: ${amountRequested}`,
        `Callback number given: ${callbackNumber}`,
        `What happened: ${incident.summary}`,
        `Money lost: none`,
    ].join('\n');
    action('report_draft', 'done', draft);
}

// ---------------------------------------------------------------------------
// Replay (SPEC §9): feed a fixture through the same detector + dashboard path.
// ---------------------------------------------------------------------------
let activeReplay = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runReplay(call, lines) {
    for (const line of lines) {
        await sleep(2000);
        if (activeReplay !== call) return; // a newer replay replaced this one
        if (line.speaker === 'scammer') {
            await handleScammerLine(call.callSid, line.text);
        } else {
            // Grandma's side: once taken over, the same lines are Rose's.
            addUtterance(call, call.takenOver ? 'rose' : 'grandma', line.text);
        }
    }
    await sleep(2000);
    if (activeReplay === call) endCall(call.callSid);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Dashboard page
fastify.get('/', async (request, reply) => {
    const html = await readFile(new URL('./public/dashboard.html', import.meta.url), 'utf8');
    reply.type('text/html').send(html);
});

// Incoming call (SPEC §7.1): transcribe the scammer's side, ring grandma.
fastify.post('/incoming', async (request, reply) => {
    const callSid = request.body?.CallSid;
    // Trust the host Twilio actually reached us on: a stale PUBLIC_HOST in .env
    // (ngrok restarted) would otherwise send transcripts and the takeover stream nowhere.
    const reached = request.headers.host || '';
    const host = reached && !/^(localhost|127\.|\[::1\])/.test(reached) ? reached : PUBLIC_HOST;
    if (callSid) newCall(callSid, { host });
    console.log(`[${callSid}] incoming call via ${host}`);
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Transcription statusCallbackUrl="https://${host}/transcripts" track="inbound_track" partialResults="false"/>
  </Start>
  <Dial>${xmlEscape(allowedNumber(GRANDMA_PHONE))}</Dial>
</Response>`;
    reply.type('text/xml').send(twimlResponse);
});

// Twilio Real-Time Transcription callback. Field names verified against
// https://www.twilio.com/docs/voice/twiml/transcription (Nov 2026).
fastify.post('/transcripts', async (request, reply) => {
    const body = request.body || {};
    if (body.TranscriptionEvent === 'transcription-content' && body.Final !== 'false') {
        let text = '';
        try {
            text = JSON.parse(body.TranscriptionData).transcript || '';
        } catch {
            console.error('Could not parse TranscriptionData');
        }
        if (text.trim() && body.CallSid) {
            const call = calls.get(body.CallSid);
            if (call?.state === 'takeover') call.twilioAfterTakeover = true;
            handleScammerLine(body.CallSid, text.trim()); // not awaited: answer Twilio right away
        }
    } else if (body.TranscriptionEvent === 'transcription-error') {
        console.error(`[${body.CallSid}] transcription error ${body.TranscriptionErrorCode}: ${body.TranscriptionError}`);
    } else if (body.TranscriptionEvent) {
        console.log(`[${body.CallSid}] ${body.TranscriptionEvent}`);
    }
    reply.send('');
});

// Manual takeover (dashboard button)
fastify.post('/api/takeover/:callSid', async (request, reply) => {
    const ok = await takeover(request.params.callSid);
    reply.send({ ok });
});

// Call status callback
fastify.post('/status', async (request, reply) => {
    const { CallSid, CallStatus } = request.body || {};
    console.log(`[${CallSid}] status ${CallStatus}`);
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(CallStatus)) endCall(CallSid);
    reply.send('');
});

// Replay a fixture ("Replay IRS" button and scripts/replay.js)
fastify.post('/api/replay/:name', async (request, reply) => {
    const name = request.params.name;
    if (!/^[a-z0-9_-]+$/i.test(name)) return reply.code(400).send({ error: 'bad fixture name' });
    let fixture;
    try {
        fixture = JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
    } catch {
        return reply.code(404).send({ error: 'fixture not found' });
    }
    const call = newCall(`REPLAY-${name}-${Date.now()}`, { replay: true });
    activeReplay = call;
    runReplay(call, fixture.lines).catch((err) => console.error('replay error:', err.message));
    reply.send({ callSid: call.callSid });
});

fastify.register(async (fastify) => {
    // Dashboard event feed
    fastify.get('/dashboard', { websocket: true }, (connection) => {
        dashboards.add(connection);
        for (const event of history) connection.send(JSON.stringify(event));
        connection.on('close', () => dashboards.delete(connection));
    });

    // WebSocket route for media-stream: Rose takes the call
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let callSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let openAiReady = false;
        let sessionStarted = false;

        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}&temperature=${TEMPERATURE}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const call = calls.get(callSid);
            const soFar = (call?.transcript || [])
                .filter((l) => l.speaker === 'scammer')
                .map((l) => `- ${l.text}`)
                .join('\n');

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: REALTIME_MODEL,
                    output_modalities: ["audio"],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                        output: { format: { type: 'audio/pcmu' }, voice: VOICE },
                    },
                    instructions: `${SYSTEM_MESSAGE}\n\nHere is what the caller said so far:\n${soFar || '(nothing yet)'}`,
                },
            };

            console.log('Sending session update');
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Separate update so that, if it is rejected, the audio settings above still stand.
            // Gives us the scammer's words in case Twilio transcription stops after the redirect (SPEC §7.2).
            openAiWs.send(JSON.stringify({
                type: 'session.update',
                session: { type: 'realtime', audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } },
            }));

            sendInitialConversationItem();
        };

        // Start the session once both sockets are ready (we need callSid for the transcript)
        const maybeInitialize = () => {
            if (openAiReady && callSid !== null && !sessionStarted) {
                sessionStarted = true;
                initializeSession();
            }
        };

        // Rose speaks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: `(You just picked the phone back up.) Say exactly this and nothing else: "${FIRST_LINE}"`
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(() => {
                openAiReady = true;
                maybeInitialize();
            }, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response.type === 'error' ? response.error : '');
                }

                if (response.type === 'response.output_audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }

                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                // Rose's words -> dashboard
                if (response.type === 'response.output_audio_transcript.done' && response.transcript?.trim()) {
                    const call = calls.get(callSid);
                    if (call && call.state !== 'ended') addUtterance(call, 'rose', response.transcript.trim());
                }

                // Scammer's words, only if Twilio transcription went quiet after the redirect.
                // Wait a moment so Twilio's copy of the same line can win.
                if (response.type === 'conversation.item.input_audio_transcription.completed' && response.transcript?.trim()) {
                    const text = response.transcript.trim();
                    setTimeout(() => {
                        const call = calls.get(callSid);
                        if (call && !call.twilioAfterTakeover) handleScammerLine(callSid, text);
                    }, 3000);
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        callSid = data.start.customParameters?.callSid || data.start.callSid || '';
                        console.log('Incoming stream has started', streamSid, 'for call', callSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        maybeInitialize();
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
            // The stream only closes when the scammer's call is over. Covers a missing /status callback.
            if (callSid) endCall(callSid);
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    const unset = Object.entries({ PUBLIC_HOST, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, GRANDMA_PHONE, FAMILY_PHONE })
        .filter(([, v]) => !v || v === '+1' || v.startsWith('xxxx'))
        .map(([k]) => k);
    if (unset.length) console.warn(`Not set in .env (replay still works, real calls will not): ${unset.join(', ')}`);
});
