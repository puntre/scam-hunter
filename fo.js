// Talks to Wajo's Fo over its MCP server (https://mcp.api.wajo.ai/fo).
// Auth is OAuth with a one-time browser login: run `node scripts/fo-login.js`.
// Tokens live in .fo-auth.json (gitignored) and are never logged.
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const FO_MCP_URL = 'https://mcp.api.wajo.ai/fo';
export const FO_AUTH_BASE = 'https://mcp.api.wajo.ai';
const AUTH_FILE = new URL('./.fo-auth.json', import.meta.url);

export async function loadAuth() {
    try {
        return JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    } catch {
        return null;
    }
}

export async function saveAuth(auth) {
    await writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export async function tokenRequest(params) {
    const res = await fetch(`${FO_AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Fo token request failed (${res.status})`);
    return res.json();
}

async function accessToken() {
    const auth = await loadAuth();
    if (!auth?.refresh_token && !auth?.access_token) throw new Error('Fo is not logged in. Run: node scripts/fo-login.js');
    if (auth.access_token && Date.now() < (auth.expires_at || 0) - 60000) return auth.access_token;
    if (!auth.refresh_token) throw new Error('Fo login expired. Run: node scripts/fo-login.js');
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.client_id });
    await saveAuth({
        client_id: auth.client_id,
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token || auth.refresh_token,
        expires_at: Date.now() + (fresh.expires_in || 3600) * 1000,
    });
    return fresh.access_token;
}

export async function foLoggedIn() {
    const auth = await loadAuth();
    return Boolean(auth?.refresh_token || auth?.access_token);
}

function parseResult(result) {
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((c) => c.type === 'text')?.text || '';
    try {
        return JSON.parse(text);
    } catch {
        return { status: result.isError ? 'failed' : 'complete', response: text };
    }
}

// Sends one request to Fo in a fresh conversation and follows it until Fo is done.
// onProgress(text) is called with Fo's progress lines. Resolves with Fo's final reply.
export async function askFo(message, onProgress = () => {}, maxMinutes = 5) {
    const token = await accessToken();
    const client = new Client({ name: 'scam-hunter', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(FO_MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    try {
        const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 90000 }).then(parseResult);
        let reply = await call('ask_fo', { message, newConversation: true });
        const deadline = Date.now() + maxMinutes * 60000;
        while (reply.status === 'working') {
            if (reply.progress) onProgress(reply.progress);
            if (Date.now() > deadline) throw new Error('Fo is still working; stopped waiting');
            reply = await call('get_fo_reply', { conversationId: reply.conversationId, waitSeconds: 40 });
        }
        if (reply.status === 'failed') throw new Error(reply.response || reply.progress || 'Fo could not do it');
        return reply.response || reply.progress || 'Done';
    } finally {
        await client.close().catch(() => {});
    }
}
