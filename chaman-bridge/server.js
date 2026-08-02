// termux-bridge/server.js
// Ye tere apne device (Termux) pe chalta hai — `npm start` se.
// Ye server tera device Chaman AI (public web app) se connect karne deta hai,
// taaki AI jo bhi shell command suggest kare, wo tu manually "▶ Run" dabaake
// apne hi device pe chala sake.
//
// SECURITY MODEL (important — isko badalna mat):
//   1. Token gate       — har request/WS connection ek secret token ke saath
//                          aana zaroori hai (query ?token=... ya header).
//                          Token pehli baar yahi generate karta hai aur
//                          .bridge-token file mein save karta hai.
//   2. Origin allowlist  — sirf ALLOWED_ORIGIN env var (default: tera Vercel
//                          domain) se aane wale requests accept hote hain.
//   3. Human-in-the-loop — server khud kabhi kisi command ko "decide" karke
//                          nahi chalata. AI sirf suggest karta hai, browser
//                          mein "▶ Run" button dabne par hi command yahan
//                          tak pahunchti hai. BLOCKED_PATTERNS ek chhota
//                          speed-bump hai, real security boundary nahi hai —
//                          real boundary tera apna Run-button click hai.
//   4. Loopback-only     — server sirf 127.0.0.1 pe bind hota hai, kabhi
//                          0.0.0.0 pe nahi. Isse device ka koi bhi port
//                          seedha internet/LAN se reachable nahi hota;
//                          sirf isi device ke browser se Chrome/Firefox ki
//                          Local Network Access (LNA) permission ke through
//                          hi pahunch milti hai.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://chaman-ai.vercel.app';
const TOKEN_FILE = path.join(__dirname, '.bridge-token');

// ── Token: pehli baar generate karo, uske baad wahi persist rehta hai ──────
function loadOrCreateToken() {
  if (process.env.TOKEN) return process.env.TOKEN;
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return token;
  }
}
const TOKEN = loadOrCreateToken();

// ── Bahut hi bunyaadi speed-bump — security boundary NAHI hai ──────────────
// (real boundary: AI kabhi khud execute nahi karta, sirf tu Run dabata hai)
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/(\s|$)/,           // rm -rf /
  /\bmkfs\b/,                        // format a filesystem
  /\bdd\s+.*of=\/dev\/(sd|mmcblk|disk)/, // raw-write to a block device
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:/, // classic fork bomb
];

function isBlocked(cmd) {
  return BLOCKED_PATTERNS.some((re) => re.test(cmd));
}

// ── Tool probe — connect hote hi bata do kya-kya installed hai ─────────────
function probeTools() {
  return new Promise((resolve) => {
    const names = ['python3', 'pip', 'node', 'npm', 'git', 'curl', 'wget', 'ffmpeg', 'yt-dlp'];
    const cmd = names.map((n) => `printf '%s=' ${n}; which ${n} >/dev/null 2>&1 && echo yes || echo no`).join('; ');
    const p = spawn('bash', ['-lc', cmd]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => {
      const tools = {};
      out.split('\n').forEach((line) => {
        const m = line.match(/^(\S+)=(yes|no)$/);
        if (m) tools[m[1]] = m[2] === 'yes';
      });
      resolve(tools);
    });
    p.on('error', () => resolve({}));
  });
}

function checkAuth(req) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || req.headers['x-bridge-token'];
  const origin = req.headers['origin'];
  if (token !== TOKEN) return false;
  // Same-device browser tools (curl/native apps) won't send an Origin header —
  // sirf jab Origin header maujood ho tabhi ise allowlist ke against check karo.
  if (origin && origin !== ALLOWED_ORIGIN) return false;
  return true;
}

const EXIT_MARKER = '__CHAMAN_EXIT__';

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS — sirf allowlisted origin ko hi response readable hone do
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    probeTools().then((tools) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cwd: process.cwd(), tools, host: os.hostname() }));
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/bridge' || !checkAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let cwd = process.cwd();
  let child = null;

  const send = (obj) => {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket closed */ }
  };

  probeTools().then((tools) => send({ type: 'ready', cwd, tools, host: os.hostname() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'start') {
      if (child) {
        send({ type: 'error', message: 'Ek command pehle se chal rahi hai — pehle usko khatam/stop karo.' });
        return;
      }
      const command = typeof msg.command === 'string' ? msg.command.trim() : '';
      if (!command) return;
      if (isBlocked(command)) {
        send({ type: 'error', message: 'Ye command ek destructive pattern se match ho rahi hai, isliye block kar di gayi hai.' });
        return;
      }

      send({ type: 'started', command });

      // cwd persist karne ke liye: command ke baad hi ek exit-marker aur naya
      // pwd bhi print karwa dete hain, phir output se strip kar dete hain.
      const wrapped = `cd "${cwd.replace(/"/g, '\\"')}" 2>/dev/null; ${command}; __code=$?; echo "${EXIT_MARKER}:$__code:$(pwd)"`;
      child = spawn('bash', ['-lc', wrapped]);

      let tail = ''; // last partial line buffer, taaki marker line ko split hone se bachaya ja sake

      const handleChunk = (streamName) => (data) => {
        tail += data.toString();
        const lines = tail.split('\n');
        tail = lines.pop(); // aakhri incomplete line agle chunk ke liye rakh lo
        for (const line of lines) {
          const m = line.match(new RegExp(`^${EXIT_MARKER}:(-?\\d+):(.*)$`));
          if (m) {
            cwd = m[2] || cwd;
            continue; // marker line khud user ko nahi dikhani
          }
          send({ type: 'output', stream: streamName, data: line + '\n' });
        }
      };

      child.stdout.on('data', handleChunk('stdout'));
      child.stderr.on('data', handleChunk('stderr'));

      child.on('close', (code) => {
        // agar tail mein marker bacha reh gaya (last line mein) usko bhi parse karo
        const m = tail.match(new RegExp(`^${EXIT_MARKER}:(-?\\d+):(.*)$`));
        if (m) {
          cwd = m[2] || cwd;
        } else if (tail) {
          send({ type: 'output', stream: 'stdout', data: tail });
        }
        tail = '';
        child = null;
        send({ type: 'exit', code, cwd });
      });

      child.on('error', (err) => {
        child = null;
        send({ type: 'error', message: `Process start nahi ho saka: ${err.message}` });
      });
    }

    if (msg.type === 'stdin') {
      if (child && child.stdin.writable) {
        child.stdin.write(msg.data.endsWith('\n') ? msg.data : msg.data + '\n');
      }
    }

    if (msg.type === 'kill') {
      if (child) {
        child.kill('SIGKILL');
      }
    }
  });

  ws.on('close', () => {
    if (child) child.kill('SIGKILL');
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`\nChaman AI Termux bridge chal raha hai — http://127.0.0.1:${PORT}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`Token (ye Chaman AI ke Settings > Termux Bridge mein paste karo):\n  ${TOKEN}\n`);
});
