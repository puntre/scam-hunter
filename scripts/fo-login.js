// One-time login so the Scam Hunter server can send requests to Fo.
// Usage: node scripts/fo-login.js   (then approve in the browser)
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { FO_AUTH_BASE, FO_MCP_URL, loadAuth, saveAuth, tokenRequest } from '../fo.js';

const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}/callback`;
const b64 = (buf) => buf.toString('base64url');

let clientId = (await loadAuth())?.client_id;
if (!clientId) {
    const res = await fetch(`${FO_AUTH_BASE}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: 'Scam Hunter',
            redirect_uris: [REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        }),
    });
    if (!res.ok) {
        console.error(`Could not register with Fo (${res.status}): ${(await res.text()).slice(0, 200)}`);
        process.exit(1);
    }
    clientId = (await res.json()).client_id;
}

const verifier = b64(crypto.randomBytes(32));
const state = b64(crypto.randomBytes(16));
const url = new URL(`${FO_AUTH_BASE}/oauth/authorize`);
url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'mcp',
    state,
    code_challenge: b64(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    resource: FO_MCP_URL,
});

const server = http.createServer(async (req, res) => {
    const got = new URL(req.url, REDIRECT);
    if (got.pathname !== '/callback') return res.writeHead(404).end();
    const finish = (code, text) => {
        res.writeHead(code, { 'Content-Type': 'text/plain' }).end(text);
        server.close();
    };
    if (got.searchParams.get('state') !== state || !got.searchParams.get('code')) {
        finish(400, 'Login failed. Go back to the terminal and run the script again.');
        console.error(`Login failed: ${got.searchParams.get('error') || 'no code returned'}`);
        process.exitCode = 1;
        return;
    }
    try {
        const tok = await tokenRequest({
            grant_type: 'authorization_code',
            code: got.searchParams.get('code'),
            redirect_uri: REDIRECT,
            client_id: clientId,
            code_verifier: verifier,
            resource: FO_MCP_URL,
        });
        await saveAuth({
            client_id: clientId,
            access_token: tok.access_token,
            refresh_token: tok.refresh_token,
            expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
        });
        finish(200, 'Scam Hunter is connected to Fo. You can close this tab.');
        console.log('Connected to Fo. Login saved to .fo-auth.json (not committed).');
    } catch (err) {
        finish(500, 'Login failed. Go back to the terminal.');
        console.error(err.message);
        process.exitCode = 1;
    }
});

server.listen(PORT, () => {
    console.log(`Open this link to connect Scam Hunter to Fo:\n\n${url}\n`);
    spawn('xdg-open', [url.toString()], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
});
