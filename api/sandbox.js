// api/sandbox.js
// Vercel serverless function — runs model-generated Python inside a real,
// ephemeral Vercel Sandbox (Firecracker microVM), replacing the old
// in-browser Pyodide Web Worker.
//
// Why this replaces Pyodide:
//   - Real filesystem + real network (pip install works now)
//   - No "stuck worker" bug — every call gets a BRAND NEW sandbox, so a
//     timeout/kill never leaves a poisoned shared worker for later runs
//   - Binary files (images, PDFs, etc.) work — Pyodide's worker could only
//     read back text/utf8 files
//
// Setup needed (one-time):
//   npm install @vercel/sandbox
//   Local dev: `vercel link` then `vercel env pull` (gives VERCEL_OIDC_TOKEN
//   in .env.local, expires after 12h — re-run `vercel env pull` when it does)
//   Production on Vercel: auth is automatic, nothing to configure.
//
// Trade-off to know: unlike the old Pyodide sandbox, this one has real
// network access by default (needed for pip install) — there's no simple
// SDK flag to fully air-gap it like Docker's NetworkMode:'none' did.

import { Sandbox } from '@vercel/sandbox';

const WORKDIR = '/vercel/sandbox';
const RUN_TIMEOUT_MS = 45_000; // hard cap on the whole run (create + exec) — bumped
// from 15s: Vercel Hobby (with fluid compute, default-on for new projects)
// allows up to 300s max duration, so 15s was an artificially tight
// self-imposed limit that heavy `pip install`s (rembg, torch, etc.) would
// blow past on a cold sandbox. 45s gives real headroom while still
// failing reasonably fast for genuinely broken/infinite-loop code.

// inputFiles ke values do shape mein aa sakte hain: (1) legacy plain string
// (text files — utf8 maana jaata hai), ya (2) {content, encoding} object
// (images/binary attachments — 'base64' encoding decode karke real bytes
// milte hain). Dono handle karta hai taaki Python ko attached image asli
// bytes ki tarah mile, corrupted text ki tarah nahi.
function toBuffer(content) {
  if (content && typeof content === 'object' && typeof content.content === 'string') {
    if (content.encoding === 'base64') {
      try {
        return Buffer.from(content.content, 'base64');
      } catch {
        return Buffer.alloc(0);
      }
    }
    return Buffer.from(content.content, 'utf8');
  }
  return Buffer.from(content == null ? '' : String(content), 'utf8');
}

// Heuristic binary-vs-text detector. A NUL byte is a hard binary signal.
// Otherwise, round-trip the buffer through utf8 decode/encode — genuine text
// survives losslessly, while binary content (PNG/PDF/etc.) does NOT round-trip
// (invalid byte sequences get silently replaced with U+FFFD by Buffer#toString,
// so a straight `.toString('utf8')` on binary data corrupts it without ever
// throwing — that's the bug this function exists to catch).
function isLikelyBinary(buf) {
  if (buf.includes(0)) return true;
  const asUtf8 = buf.toString('utf8');
  const reEncoded = Buffer.from(asUtf8, 'utf8');
  return !reEncoded.equals(buf);
}

// Lists a directory inside the sandbox via `ls -1A` and reads each file back.
// Text files are returned as utf8 strings; binary files (images, PDFs, etc.)
// are base64-encoded so they survive the round trip intact. Each entry is
// tagged with its encoding so callers (and the frontend) know how to handle it.
async function readDirAsFiles(sandbox, dirName) {
  const out = {};
  let listing;
  try {
    listing = await sandbox.runCommand('ls', ['-1A', dirName], { cwd: WORKDIR });
  } catch (e) {
    return out; // dir might not exist yet — treat as empty
  }
  if (listing.exitCode !== 0) return out;
  const names = (await listing.stdout())
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    try {
      const buf = await sandbox.readFileToBuffer({ path: `${dirName}/${name}` });
      if (buf === null) continue;
      if (isLikelyBinary(buf)) {
        out[name] = { content: buf.toString('base64'), encoding: 'base64' };
      } else {
        out[name] = { content: buf.toString('utf8'), encoding: 'utf8' };
      }
    } catch (e) {
      // genuinely unreadable — skip
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST use kar bhai' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const code = typeof body?.code === 'string' ? body.code : '';
  const inputFiles = body?.inputFiles && typeof body.inputFiles === 'object' ? body.inputFiles : {};

  if (!code.trim()) {
    res.status(400).json({ ok: false, error: 'code chahiye' });
    return;
  }

  let sandbox = null;
  let timedOut = false;

  try {
    sandbox = await Sandbox.create({
      runtime: 'python3.13',
      timeout: RUN_TIMEOUT_MS,
      persistent: false, // one-off run — don't snapshot/keep around after stop()
    });

    await sandbox.mkDir('uploads');
    await sandbox.mkDir('modify');
    await sandbox.mkDir('outputs');

    // Seed uploads/ (read-only original) + modify/ (editable working copy) —
    // same convention as the old Pyodide sandbox.
    const modifySnapshot = {};
    const seedWrites = [];
    for (const [name, content] of Object.entries(inputFiles)) {
      seedWrites.push({ path: `uploads/${name}`, content: toBuffer(content) });
      seedWrites.push({ path: `modify/${name}`, content: toBuffer(content) });
      // Binary (base64) inputs are always treated as "changed" later regardless
      // of snapshot value (see outputFiles diff below), so snapshot only needs
      // to be meaningful for plain-text inputs — avoids storing "[object Object]".
      // Guard: if content is object-shaped but NOT base64 and its `.content`
      // is missing/null (malformed input), `String(undefined)` would silently
      // store the literal string "undefined" as the snapshot — a bogus value
      // that could cause a false "changed" or false "unchanged" diff result
      // later. Treat that case as an empty string instead.
      const isBase64Obj = content && typeof content === 'object' && content.encoding === 'base64';
      let snapshotValue = '';
      if (!isBase64Obj) {
        if (content && typeof content === 'object') {
          snapshotValue = content.content == null ? '' : String(content.content);
        } else {
          snapshotValue = content == null ? '' : String(content);
        }
      }
      modifySnapshot[name] = isBase64Obj ? null : snapshotValue;
    }
    seedWrites.push({ path: 'run.py', content: toBuffer(code) });
    await sandbox.writeFiles(seedWrites);

    // Race the actual run against our own timeout so we can force-stop the
    // sandbox (not just give up waiting) — this is what actually fixes the
    // "runaway code keeps eating resources forever" bug from the old worker.
    const runPromise = sandbox.runCommand('python3', ['run.py'], { cwd: WORKDIR });
    // If the timeout branch wins the race below, `sandbox.stop()` (in the
    // `finally` block) will kill the VM while this promise is still pending,
    // which very likely rejects it (broken pipe / killed process). Nobody
    // else ever attaches a handler to `runPromise` in that case, so without
    // this no-op catch it becomes an unhandled promise rejection — which on
    // some Node/Vercel runtimes can crash the whole serverless invocation,
    // taking down other concurrent requests with it. This catch just makes
    // sure the rejection is always consumed; the timeout path already builds
    // its own response independently of this promise's outcome.
    runPromise.catch(() => {});
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => { timedOut = true; resolve(null); }, RUN_TIMEOUT_MS);
    });
    const result = await Promise.race([runPromise, timeoutPromise]);

    if (timedOut || result === null) {
      res.json({
        ok: false,
        stdout: '',
        error: `Timeout — code ${RUN_TIMEOUT_MS / 1000} second se zyada chal gaya, sandbox force-stop kar diya gaya.`,
      });
      return;
    }

    const stdout = await result.stdout();
    const stderr = await result.stderr();
    const combinedOut = [stdout, stderr].filter(Boolean).join('\n');

    if (result.exitCode !== 0) {
      res.json({ ok: false, stdout: combinedOut, error: `Exit code ${result.exitCode}${stderr ? ':\n' + stderr : ''}` });
      return;
    }

    // Diff modify/ against the pre-run snapshot, collect outputs/ as-is —
    // identical "modified vs new" logic to the old Pyodide worker.
    const modifyNow = await readDirAsFiles(sandbox, 'modify');
    const outputsNow = await readDirAsFiles(sandbox, 'outputs');

    const outputFiles = [];
    for (const [name, file] of Object.entries(modifyNow)) {
      // Binary files can't be cheaply/meaningfully diffed against the
      // (always-text) pre-run snapshot, so treat any binary modify/ file as
      // changed. Text files keep the original exact-match diff behaviour.
      const changed = file.encoding === 'base64'
        ? true
        : (!(name in modifySnapshot) || modifySnapshot[name] !== file.content);
      if (changed) {
        outputFiles.push({ name, path: `modify/${name}`, kind: 'modified', content: file.content, encoding: file.encoding });
      }
    }
    for (const [name, file] of Object.entries(outputsNow)) {
      outputFiles.push({ name, path: `outputs/${name}`, kind: 'new', content: file.content, encoding: file.encoding });
    }

    res.json({ ok: true, stdout: combinedOut, outputFiles });
  } catch (err) {
    res.status(500).json({ ok: false, stdout: '', error: 'Sandbox error: ' + String(err?.message || err) });
  } finally {
    if (sandbox) {
      // Always tear the sandbox down — this is the equivalent of the
      // worker.terminate() the old code was missing. Every request gets a
      // fresh sandbox next time, so nothing can stay stuck across runs.
      try { await sandbox.stop(); } catch (e) { /* already gone, fine */ }
    }
  }
}
