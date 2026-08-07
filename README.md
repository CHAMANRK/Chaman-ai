# 🌙 Chaman AI

**Ek Hinglish-first AI assistant jo sirf baat nahi karta — kaam bhi karta hai.**
Web pe live web-search kar sakta hai, real Python code cloud sandbox mein chala sakta hai, tera Termux (Android) device seedha command bhi run kar sakta hai (tere permission se), aur Quran Quiz bhi khila sakta hai. Sab kuch ek clean, dark-themed chat UI ke andar.

> Built by **Najeef** · Hosted on **Vercel** · Model backend: **Groq → OpenRouter → Cerebras → Mistral** (auto-fallback chain)

---

## ✨ Features

### 🧠 Smart, resilient AI core
- **4-provider fallback chain** — Groq se shuru, phir OpenRouter, Cerebras, aur (optional) Mistral. Ek provider fail/rate-limit ho to agla khud-ba-khud try hota hai — user ko kabhi downtime feel nahi hota.
- **RAG-powered knowledge retrieval** — apna knowledge base (`knowledge/*.md`) embeddings mein convert hota hai; har query pe Gemini se live embedding banaakar cosine-similarity se sabse relevant chunks system prompt mein inject hote hain. Poora knowledge base har baar resend nahi hota — sirf jo chahiye.
- **Hinglish-native personality** — default Roman-script Hinglish, pure English input pe English reply, Hindi/Urdu script input pe usi script mein jawab.

### ⚡ Structured "Actions" protocol
Model ek generic `[ACTION:name]{...}[/ACTION]` tag system se real kaam karta hai:

| Action | Kya karta hai |
|---|---|
| 🔍 `web_search` | Live/current info ke liye real-time web search |
| 🐍 `run_code` | Python code ek **real ephemeral cloud sandbox** (Vercel Sandbox / Firecracker microVM) mein run — file read/write, pip install, sab real |
| 📱 `termux_run` | User ke apne Android device pe real shell command — sirf tab chalti hai jab user khud "▶ Run" dabaye |
| ❓ `ask_user` | Genuinely ambiguous case mein interactive clarifying question (with tappable options) |
| 📖 `quran_quiz_start` | Live Quran Quiz session shuru karta hai |

Robust parsing built-in: model kabhi-kabhi malformed JSON ya galat markdown-fencing bhejta hai — server-side normalization aur auto-repair isse silently fix kar deta hai, taaki raw JSON kabhi user ko na dikhe.

### 🐍 Real Python Sandbox
- Har run ek **brand-new, ephemeral Firecracker microVM** mein hota hai — koi "stuck worker" bug nahi.
- Real filesystem + real network → `pip install` bhi kaam karta hai.
- Binary files (images, PDFs, etc.) fully supported — purane Pyodide-based worker se ek badi upgrade.
- `uploads/` (read-only original), `modify/` (editable working copy), `outputs/` (naye files) — clean 3-folder convention.
- Hard 45s timeout + forced sandbox teardown — runaway/infinite-loop code kabhi resources hamesha ke liye nahi khaata.

### 📲 Termux Bridge — apne hi phone pe AI se command chalwao
Ek chhota Node.js server jo **tere apne Termux (Android)** pe chalta hai aur web app ko tere device se securely connect karta hai:

- 🔐 **Token-gated** — secret token har request/WebSocket connection ke saath zaroori
- 🌐 **Origin allowlist** — sirf tera Vercel domain accept hota hai
- 🖐️ **Human-in-the-loop by design** — AI kabhi khud koi command execute nahi karta, sirf suggest karta hai. Real chalane ka decision **hamesha tera** hota hai (▶ Run button)
- 🔒 **Loopback-only bind** (`127.0.0.1`) — koi bhi port seedha internet/LAN se reachable nahi hota
- 🛑 Basic destructive-pattern speed-bump (`rm -rf /`, `mkfs`, fork bombs, raw disk writes)
- 🔁 **Live reconnect support** — command chal rahi ho aur tu tab close/lock kare, to command background mein chalti rehti hai; wapas aane pe poora missed output "catch-up" ho jaata hai
- ⌨️ **Interactive stdin detection** — agar koi command password/confirmation maang rahi hai, `/proc` ke through detect karke turant UI mein prompt dikha deta hai
- 🧰 Auto tool-probe on connect — `python3`, `node`, `git`, `ffmpeg`, `yt-dlp` waghera installed hain ya nahi, turant pata chal jaata hai

### 📖 Quran Quiz
Interactive quiz card jo Para range aur sawaal-count poochta hai, phir live ayat dikhaakar Surah/Para/Page guess karwaata hai — turant feedback ke saath, session-tracked scoring.

### 💬 Polished Chat UI
- Dark theme, sessions drawer (localStorage-backed chat history)
- Settings page — Profile + Termux Bridge status/connect flow
- File upload support, copyable code blocks, live "▶ Run" buttons for both `termux_run` actions and plain shell code blocks
- Onboarding flow for first-time users

---

## 🏗️ Tech Stack

- **Frontend:** Vanilla JS + HTML/CSS (no framework bloat), single-page chat app
- **Backend:** Vercel Serverless Functions (Node.js, ES modules)
- **AI Providers:** Groq, OpenRouter, Cerebras, Mistral (fallback chain)
- **Embeddings/RAG:** Gemini `gemini-embedding-001`
- **Code Sandbox:** `@vercel/sandbox` (Firecracker microVM, Python 3.13)
- **Device Bridge:** Node.js + `ws` (WebSocket), runs locally on Termux

---

## 📂 Project Structure

```
├── index.html          # Poora frontend — chat UI, sessions, settings, quiz cards
├── api/
│   ├── chat.js          # Main chat endpoint — fallback chain, RAG, action protocol
│   └── sandbox.js        # Python code execution via Vercel Sandbox
└── termux-bridge/
    └── server.js         # Local bridge server — token-gated, loopback-only
```

---

## ⚙️ Setup

### 1. Web app (Vercel)
Environment variables set karo (Project → Settings → Environment Variables):

```
GROQ_API_KEY        # required
OPENROUTER_API_KEY  # required
CEREBRAS_API_KEY    # required
MISTRAL_API_KEY     # optional
GEMINI_API_KEY       # optional — RAG ke liye
```

Sandbox ke liye local dev mein:
```bash
npm install @vercel/sandbox
vercel link
vercel env pull   # VERCEL_OIDC_TOKEN milega (.env.local mein), ~12h mein expire hota hai
```
Production pe Vercel auth automatic hai — kuch configure nahi karna.

### 2. Termux Bridge (apne Android device pe)
```bash
cd termux-bridge
npm install
npm start
```
Pehli baar run karne pe ek token generate hokar `.bridge-token` mein save ho jaata hai — usko app ke **Settings → Termux Bridge** mein paste karo. Bas, connected!

---

## 🔒 Security Philosophy

Termux Bridge ka pura design ek principle pe based hai:

> **AI sirf suggest karta hai — decide aur execute hamesha tu karta hai.**

Server khud kabhi koi command "decide" karke nahi chalata. Token gate, origin allowlist, aur loopback-only binding sab layers hain — lekin asli security boundary tera apna **"▶ Run"** button-press hai.

---

*Made with 🌙 by Najeef — questions? `hellochaman532@gmail.com`*
