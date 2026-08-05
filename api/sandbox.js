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

function toBuffer(content) {
  return Buffer.from(content == null ? '' : String(content), 'utf8');
}

// Lists a directory inside the sandbox via `ls -1A` and reads each file back
// as utf8 text. Binary/unreadable files are skipped (same limitation the old
// Pyodide sandbox had — can extend to base64 later if binary output is needed).
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
      out[name] = buf.toString('utf8');
    } catch (e) {
      // binary or unreadable — skip, same as old Pyodide behaviour
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
      modifySnapshot[name] = String(content);
    }
    seedWrites.push({ path: 'run.py', content: toBuffer(code) });
    await sandbox.writeFiles(seedWrites);

    // Race the actual run against our own timeout so we can force-stop the
    // sandbox (not just give up waiting) — this is what actually fixes the
    // "runaway code keeps eating resources forever" bug from the old worker.
    const runPromise = sandbox.runCommand('python3', ['run.py'], { cwd: WORKDIR });
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
    for (const [name, data] of Object.entries(modifyNow)) {
      if (!(name in modifySnapshot) || modifySnapshot[name] !== data) {
        outputFiles.push({ name, path: `modify/${name}`, kind: 'modified', content: data });
      }
    }
    for (const [name, data] of Object.entries(outputsNow)) {
      outputFiles.push({ name, path: `outputs/${name}`, kind: 'new', content: data });
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
