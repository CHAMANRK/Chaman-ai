# Chaman AI — Knowledge Base

<!--
  Ye file Chaman AI ke RAG system ka source hai. Har "## Heading" ek chunk
  ban jaata hai (build-embeddings.js isi se split karta hai) — isliye har
  section ek self-contained fact/topic rakho, bahut lamba ek chunk mat
  banao (ideally 50-150 words). Jitna specific utna behtar retrieval milega.
  File edit karne ke baad `node scripts/build-embeddings.js` chalana zaroori
  hai — warna naya content search mein nahi aayega.
-->

## Creator aur Contact
Chaman AI ko Najeef (poora naam Sekh Najiful Islam) ne banaya hai, jo
"Chaman Bhai Production" brand ke under kaam karte hain. Contact:
hellochaman532@gmail.com. Instagram: with_chaman.

## Available Actions
Chaman AI ke paas 5 live actions hain: web_search (current info ke liye),
run_code (Python, Vercel Sandbox mein server-side chalta hai), termux_run
(user ke phone ke Termux app pe command chalata hai, Bridge connect hona
chahiye), ask_user (clarifying question poochta hai), aur quran_quiz_start
(Quran Ayat Quiz shuru karta hai).

## run_code sandbox details
run_code action Vercel Sandbox (real ephemeral Firecracker microVM) mein
chalta hai — 2026-08-05 ko Pyodide (browser WASM) se migrate kiya gaya.
Real network available hai (pip install kaam karta hai), 15 second timeout,
3-folder convention: uploads/ (read-only original), modify/ (edit karne ke
liye), outputs/ (nayi files ke liye).

## Termux Bridge — working directory convention
Termux ke andar command chalate waqt Chaman AI apni marzi se jahan-tahan
file nahi banata — 2 fix working directories use karta hai:
- `~/Chaman_ai` (Termux ka apna private storage) — AI ke apne kaam ke liye:
  scripts `~/Chaman_ai/scripts/` mein, backups `~/Chaman_ai/backup/` mein.
  User inhe directly Termux se hi access karta hai.
- `/sdcard/Chaman_ai` (phone ki shared storage) — user-facing files ke
  liye: downloaded video, processed image, ya koi bhi final output jo user
  ko chahiye/dekhna hai. Ye gallery/file manager se bhi visible hota hai.
Dono folders missing hon to pehli baar khud ban jaate hain (`mkdir -p`).
Agar `/sdcard` access nahi hai (storage permission di hi nahi gayi), AI
force nahi karta — user se poochta hai permission de ya sirf `~/Chaman_ai`
pe kaam chale. Agar user kisi aise file/folder ka naam le jo `Chaman_ai`
ke andar nahi hai, AI use poore `/sdcard` mein dhoondta hai, sirf apne
Chaman_ai folder tak khud ko restrict nahi karta.

## Recent updates (2026-08-05)
Is din 3 badi cheezein hui: (1) system prompt aur protocol docs ko ~65%
chhota kiya gaya token cost kam karne ke liye, (2) run_code sandbox Pyodide
se Vercel Sandbox pe migrate hua (real network + no stuck-worker bug),
(3) Mistral fallback provider default se hata diya gaya kyunki uska koi
genuinely free model nahi hai — ab sirf Groq/OpenRouter/Cerebras (teeno free)
default fallback chain mein hain.

## Backend/Tech stack
Chaman AI Vercel serverless functions pe host hai. LLM providers: Groq
(openai/gpt-oss-120b), OpenRouter (openai/gpt-oss-20b:free), Cerebras
(llama-3.3-70b) — teeno free tier. Web search Tavily API se hoti hai
(1000 searches/month free tier).

## PWA support — manifest + service worker (2026-08-08)
Chaman AI ab ek installable PWA hai. `manifest.json` (name "Chaman AI",
`display: standalone`, existing `logo.png` hi icon) aur `sw.js` (service
worker) add kiye gaye. Service worker cache-first + stale-while-revalidate
strategy se app-shell (HTML, manifest, logo, fonts, KaTeX) cache karta hai
— isliye dusri baar app open karte waqt logo/icons dobara load nahi hote,
turant khulta hai, aur offline pe bhi shell available rehta hai. Chat/API
calls (`/api/`, `/chat`, `/stream` paths) is caching se explicitly bypass
kiye gaye hain — wo hamesha fresh network se jaate hain, kabhi stale cache
se serve nahi hote. Naya shell deploy karte waqt `sw.js` ke andar
`CACHE_NAME` version bump (v1 → v2) karna zaroori hai, warna purana cached
shell hi dikhta rehta hai.
