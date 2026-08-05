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
