// LLM helpers: scam detector (SPEC §9) and incident summary (SPEC §10.1).

export const STRONG_SIGNALS = ['impersonation', 'unusual_payment', 'code_or_remote_access'];
export const MEDIUM_SIGNALS = ['urgency_or_threat', 'secrecy'];
const ALL_SIGNALS = [...STRONG_SIGNALS, ...MEDIUM_SIGNALS];

async function chatJson(system, user) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: process.env.DETECTOR_MODEL || 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
}

const formatLines = (lines) => lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');

const DETECTOR_PROMPT = `You screen live phone calls to an elderly woman for scams. You see the most recent lines, mostly from the caller ("scammer" is just the label for the caller; it does not mean they are one).

Reply with JSON only: {"signals": [], "score": 0, "reason": "short phrase"}

signals: any of these that the caller has clearly shown in these lines:
- "impersonation": claims to be a government agency, police, bank fraud department, tech support, or a relative in trouble, in order to demand money or information. A business the person plausibly uses (pharmacy, doctor, delivery) making a routine call is NOT impersonation.
- "unusual_payment": asks for payment by gift cards, crypto, wire transfer or a payment app.
- "code_or_remote_access": asks for a verification code, PIN, password, card or account number, or to install remote-access software.
- "urgency_or_threat": threatens arrest, lawsuits, account closure, or demands action right now.
- "secrecy": tells her not to hang up or not to tell family or the bank.

score: 0-100, how likely this call is a scam, judged only on what the caller has said so far:
- under 20: routine, friendly call with no demands.
- 30-50: the caller only claims an identity (even a government agency), with no demand or threat yet. One sentence of introduction is never enough to go higher.
- 55-75: an identity claim plus a threat, pressure or secrecy, but no request for money, codes or account details yet.
- 80-100: the caller has asked for payment by an unusual method, or for a code, card or account number, or for remote access.
reason: at most 8 words.`;

export async function detect(lines) {
    const out = await chatJson(DETECTOR_PROMPT, formatLines(lines));
    const score = Math.max(0, Math.min(100, Math.round(Number(out.score))));
    if (Number.isNaN(score)) throw new Error('detector returned no score');
    return {
        signals: (Array.isArray(out.signals) ? out.signals : []).filter((s) => ALL_SIGNALS.includes(s)),
        score,
        reason: String(out.reason || '').slice(0, 120),
    };
}

const SUMMARY_PROMPT = `You are given the transcript of a scam phone call. "scammer" is the caller, "grandma" is the target, "rose" is an AI decoy that took over to stall the caller.

Reply with JSON only:
{"summary": "2 sentences on what the caller tried", "claimedAgency": "", "paymentMethod": "", "callbackNumber": "", "amountRequested": ""}

Use "unknown" for anything the caller never said. Only report what is in the transcript.`;

export async function summarize(transcript) {
    const out = await chatJson(SUMMARY_PROMPT, formatLines(transcript));
    const field = (k) => String(out[k] || 'unknown').slice(0, 300);
    return {
        summary: field('summary'),
        intel: {
            claimedAgency: field('claimedAgency'),
            paymentMethod: field('paymentMethod'),
            callbackNumber: field('callbackNumber'),
            amountRequested: field('amountRequested'),
        },
    };
}
