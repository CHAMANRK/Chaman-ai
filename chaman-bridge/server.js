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
const fsp = require('fs/promises');
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

// ── "Kya command sach mein stdin ka wait kar rahi hai?" detector ──────────
// Node ka spawn() ye seedha nahi bata sakta — isliye Linux/Android ke /proc
// se khud check karte hain. Zaroori hai poori descendant-tree dekhna, kyunki
// hum `bash -lc "..."` spawn karte hain, aur asli interactive program
// (jaise koi installer jo password/confirm maange) bash ka CHILD hota hai,
// khud bash nahi.
async function listDescendants(rootPid) {
  let entries;
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return []; // /proc readable nahi hai is device pe — gracefully give up
  }
  const childrenOf = new Map();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await fsp.readFile(`/proc/${name}/stat`, 'utf8');
      // format: pid (comm) state ppid ...  — comm mein khud ")" ho sakta hai,
      // isliye aakhri ")" ke baad se fields count karte hain.
      const closeParen = stat.lastIndexOf(')');
      const rest = stat.slice(closeParen + 2).split(' ');
      const ppid = Number(rest[1]);
      if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
      childrenOf.get(ppid).push(Number(name));
    } catch {
      // process already exit ho chuka hoga beech mein — skip
    }
  }
  const result = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const kids = childrenOf.get(pid) || [];
    for (const kid of kids) {
      result.push(kid);
      queue.push(kid);
    }
  }
  return result;
}

// Bash child ke apne fd 0 (stdin) ka pipe-inode nikaalta hai — descendants ke
// fd 0 isi inode se compare karke confirm karte hain ki wahi stdin hai, koi
// alag file/socket nahi.
async function getStdinPipeInode(pid) {
  try {
    const link = await fsp.readlink(`/proc/${pid}/fd/0`);
    const m = link.match(/pipe:\[(\d+)\]/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function isBlockedOnStdin(pid, stdinPipeInode) {
  try {
    const status = await fsp.readFile(`/proc/${pid}/status`, 'utf8');
    const stateMatch = status.match(/State:\s*(\S)/);
    if (!stateMatch || stateMatch[1] !== 'S') return false; // sirf "sleeping" state relevant hai

    const wchan = await fsp.readFile(`/proc/${pid}/wchan`, 'utf8').catch(() => '');
    if (!/read/i.test(wchan)) return false; // kisi read-jaisi kernel function mein sona chahiye

    if (stdinPipeInode) {
      const fd0 = await fsp.readlink(`/proc/${pid}/fd/0`).catch(() => null);
      if (!fd0 || !fd0.includes(stdinPipeInode)) return false; // dusri file/fd pe block hai, stdin pe nahi
    }
    return true;
  } catch {
    return false;
  }
}

// Poora descendant-tree check karta hai; koi bhi ek process stdin-block mile
// to turant true maan lo (best-effort — /proc na milne pe silently false).
async function anyDescendantWaitingOnStdin(rootPid, stdinPipeInode) {
  const pids = [rootPid, ...(await listDescendants(rootPid))];
  for (const pid of pids) {
    if (await isBlockedOnStdin(pid, stdinPipeInode)) return true;
  }
  return false;
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

// Poore process group ko maarta hai (bash + uske saare descendants), taaki
// Stop dabane pe sirf bash na mare, balki actual yt-dlp/ffmpeg/etc. bhi ruke.
// Negative PID = "is pure group ko maro" (Unix convention). detached:true se
// spawn kiya gaya child hi apne group ka leader hota hai, isliye -child.pid
// kaam karta hai. Agar kisi wajah se ye fail ho (e.g. group already gone),
// fallback mein seedha child ko hi kill kar dete hain.
function killChildGroup(child) {
  if (!child || child.pid == null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
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

  ws.on('message', async (raw) => {
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
      // stdbuf -oL -eL: pipe pe chalne ke bawajood stdout/stderr ko line-buffered
      // rakhta hai. Iske bina bahut se CLI tools (yt-dlp, ffmpeg, apt, ...)
      // isatty() false dekh ke apna output fully-buffer kar dete hain, aur
      // interactive prompt ("Overwrite? [y/N]") kabhi client tak pahunchta hi
      // nahi — jabki process sach mein stdin ka wait kar raha hota hai.
      const wrapped = `cd "${cwd.replace(/"/g, '\\"')}" 2>/dev/null; stdbuf -oL -eL bash -c ${JSON.stringify(command)}; __code=$?; echo "${EXIT_MARKER}:$__code:$(pwd)"`;
      // detached:true → bash apne khud ke naye process group ka leader banta hai.
      // Isse "kill" pe hum poore group ko (bash + uske saare descendants jaise
      // yt-dlp/ffmpeg) ek saath maar sakte hain, sirf top-level bash ko nahi —
      // warna SIGKILL sirf bash ko marta, aur actual kaam karne wala process
      // (jaise yt-dlp) orphan ban ke background mein chalta hi reh jaata.
      child = spawn('bash', ['-lc', wrapped], { detached: true });

      // EPIPE-safe: agar child pehle hi exit ho chuka ho ya usne apna stdin
      // band kar diya ho, to stdin.write() ek 'error' event throw karta hai.
      // Bina is listener ke wo unhandled hokar poore process ko crash karta hai.
      child.stdin.on('error', () => { /* EPIPE — child ne stdin band kar diya, ignore */ });

      let tail = ''; // last partial line buffer, taaki marker line ko split hone se bachaya ja sake
      let idleFlushTimer = null;
      const IDLE_FLUSH_MS = 250; // itni der koi naya data na aaye to jo bhi ruka hua hai (jaise ek prompt "Password: " jiske aage newline hi nahi aata) usko turant dikha do

      // Kya abhi tak accumulate hua `tail` EXIT_MARKER ka possible prefix hai?
      // Agar haan, to abhi flush mat karo — ho sakta hai wahi marker ban raha ho.
      function couldStillBecomeMarker(s) {
        if (!s) return false;
        const probe = s.length <= EXIT_MARKER.length ? s : s.slice(0, EXIT_MARKER.length);
        return EXIT_MARKER.startsWith(probe);
      }

      function scheduleIdleFlush(streamName) {
        clearTimeout(idleFlushTimer);
        idleFlushTimer = setTimeout(() => {
          if (tail && !couldStillBecomeMarker(tail)) {
            send({ type: 'output', stream: streamName, data: tail });
            tail = '';
          }
        }, IDLE_FLUSH_MS);
      }

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
        // Jo bacha (bina newline ke) hai, use bhi thodi der baad live dikha do —
        // taaki koi bhi interactive prompt ("Continue? [y/n] ", "Password: ")
        // turant block ke andar nazar aaye, sirf process khatam hone ka wait na ho.
        scheduleIdleFlush(streamName);
      };

      child.stdout.on('data', handleChunk('stdout'));
      child.stderr.on('data', handleChunk('stderr'));

      // ── Live "kya process stdin ka wait kar raha hai" polling ──────────
      let waitingPollTimer = null;
      let lastWaitingSent = false;
      const stdinPipeInode = await getStdinPipeInode(child.pid);

      function startWaitingPoll() {
        waitingPollTimer = setInterval(async () => {
          if (!child) return;
          const waiting = await anyDescendantWaitingOnStdin(child.pid, stdinPipeInode);
          if (waiting !== lastWaitingSent) {
            lastWaitingSent = waiting;
            send({ type: 'waiting_input', waiting });
          }
        }, 600);
      }
      function stopWaitingPoll() {
        if (waitingPollTimer) clearInterval(waitingPollTimer);
        waitingPollTimer = null;
        if (lastWaitingSent) send({ type: 'waiting_input', waiting: false });
        lastWaitingSent = false;
      }
      startWaitingPoll();

      child.on('close', (code) => {
        clearTimeout(idleFlushTimer);
        stopWaitingPoll();
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
        clearTimeout(idleFlushTimer);
        stopWaitingPoll();
        child = null;
        send({ type: 'error', message: `Process start nahi ho saka: ${err.message}` });
      });
    }

    if (msg.type === 'stdin') {
      if (child && child.stdin.writable) {
        try {
          child.stdin.write(msg.data.endsWith('\n') ? msg.data : msg.data + '\n');
        } catch { /* pipe already closed — child.stdin's 'error' listener handles it too */ }
      }
    }

    if (msg.type === 'kill') {
      killChildGroup(child);
    }
  });

  ws.on('close', () => {
    killChildGroup(child);
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`\nChaman AI Termux bridge chal raha hai — http://127.0.0.1:${PORT}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`Token (ye Chaman AI ke Settings > Termux Bridge mein paste karo):\n  ${TOKEN}\n`);
});
