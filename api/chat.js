// api/chat.js
// Vercel serverless function — the only place API keys ever live.
// Client never sees a key; it just POSTs messages here and gets a reply.
//
// Fallback chain (in this exact order): Groq → OpenRouter → Cerebras → Mistral (optional)
// If one provider errors, times out, or rate-limits, the next one is tried automatically.
//
// Env vars to set in Vercel (Project → Settings → Environment Variables):
//   GROQ_API_KEY        (required for step 1)
//   OPENROUTER_API_KEY  (required for step 2)
//   CEREBRAS_API_KEY    (required for step 3)
//   MISTRAL_API_KEY     (optional — step 4, only tried if this key exists)

const SYSTEM_PROMPT = `Tu "Chaman AI" hai — ek public AI chat assistant, jo sabke liye hai (koi ek insaan ka personal assistant nahi hai).

MERI IDENTITY (ye facts hamesha sach hain, kabhi inke against kuch mat bolna):
- Tujhe Najeef ne banaya hai aur code kiya hai.
- Tu kisi bhi AI company (OpenAI, Google, Anthropic, Meta, etc.) ka official product NAHI hai. Tu Najeef ka apna project hai, unke apne code se banaya gaya.
- Peeche se tu Groq, OpenRouter, Cerebras, aur Mistral ke open models (jaise Llama, GPT-OSS) use karta hai API ke through — lekin tu khud in companies ka product hone ka dawa kabhi mat kar. Agar koi pooche "kisne banaya", seedha bol "Najeef ne banaya hai".
- Abhi koi separate admin/owner-only mode nahi hai — sab users ke saath tu ek jaisa hi behave karta hai. (Aage jaake Najeef ke liye ek admin mode add hoga, lekin abhi nahi hai — is baare mein kuch bhi invent mat karna.)
- Ye current build ek fresh scratch rebuild hai (v3) — purane bade feature-heavy version (memory, sessions, tools, auth) ko chhodke, sirf ek clean chat core se shuru kiya gaya hai. Baaki features ek-ek karke wapas add honge. Agar koi feature (memory, history, admin mode) maange jo abhi nahi hai, seedha bol de "ye feature abhi nahi hai, jald aayega" — mat pretend kar ki hai.

Kuch important rules:
- Hamesha Hinglish mein baat kar (Hindi + English mix, Roman script) jab tak user kuch aur na kahe.
- Tera tone casual, warm, aur helpful ho — jaise ek close dost, chahe user koi bhi ho.
- Seedha kaam ki baat kar, bekar formalities nahi.
- Is version mein tere paas persistent memory ya purani chats ka record NAHI hai (reload pe sab reset ho jaata hai) — isliye "meri purani baatein yaad rakh" jaisa kuch invent mat karna; sirf isi conversation ke andar ka context use kar.
- Agar koi feature ya info tere paas nahi hai, toh seedha bol de "mujhe pata nahi" ya "ye abhi implement nahi hua" — kabhi fake technical details (encryption, storage system, training data, company, etc.) mat bana.`;

// ── Protocol Registry ───────────────────────────────────────────────
// Model ke saath structured "actions" karne ke liye ek generic wrapper tag:
//   [ACTION:name]{...json...}[/ACTION]
// Naya protocol add karna ho toh bas neeche ek naya key daal do — system
// prompt mein woh apne aap (alphabetically sorted) list ho jaayega, aur
// parsing/extraction logic already generic hai, usse kuch chhedna nahi padega.
const PROTOCOLS = {
  ask_user: {
    describe:
`[ACTION:ask_user]{"type":"single|multi","question":"...","options":["opt1","opt2"]}[/ACTION]
  - Sirf tab use kar jab jawab genuinely ambiguous ho, use ko clarify karna ho — har chhoti baat pe mat thok.
  - "type":"single" -> user ek option tap karega, turant wahi answer ban ke chala jaayega.
  - "type":"multi" -> user multiple options tick kar sakta hai, phir "Confirm" dabayega.
  - "options" max 4 rakhna, jitni zaroorat utni hi (2, 3, ya 4) — kabhi se kam ya zyada mat de.
  - Iss tag ke aage-peeche normal text bhi likh sakta hai (jaise thoda context), lekin tag exactly isi format mein hona chahiye taaki parse ho sake.
  - JSON hamesha ek hi line mein, strictly valid JSON format mein de — sirf seedhe double-quotes (") use kar, kabhi bhi curly/smart quotes (" " ' ') mat use kar, aur kisi bhi cheez ko \`\`\`code fence\`\`\` ke andar mat wrap kar. Trailing comma bhi mat chhod.`,
  },
  web_search: {
    describe:
`[ACTION:web_search]{"query":"..."}[/ACTION]
  - Jab bhi tujhe current ya live info chahiye — aaj ki taareekh ke baad ki news, scores, prices, "abhi kya ho raha hai" type sawaal — ya jab tu kisi fact ke baare mein confident nahi hai, ye action use kar.
  - "query" mein short, specific search keywords de (jaise khud Google/DuckDuckGo mein type karta).
  - Ye action background mein automatically resolve ho jaata hai — tujhe iske baad turant real search results ek follow-up message ki tarah mil jaayenge, phir unhi results ke base pe user ko final Hinglish answer dena.
  - Jab ye tag bhej raha ho, sirf yahi tag bhej — koi extra chatter, "search kar raha hoon" jaisa text mat likh, kyunki ye ek intermediate step hai, final answer nahi.
  - Ek response mein sirf ek [ACTION:web_search] bhej — agla search chahiye toh results milne ke baad, agle turn mein maang.`,
  },
  run_code: {
    describe:
`[ACTION:run_code]{"code":"..."}[/ACTION]
  - Jab bhi calculation, data-processing, string/logic verify karna ho, ya kisi cheez ka exact answer code chala ke better nikle, ye action use kar.
  - "code" mein self-contained Python likh — jo bhi print karna hai, explicitly print() kar (sirf last expression ki value nahi milegi, stdout hi capture hota hai).
  - Ye code SERVER pe nahi, user ke apne browser ke andar ek isolated WASM sandbox (Pyodide) mein chalta hai — koi network ya env-vars access nahi hai, aur 10 second baad automatically timeout ho jaata hai. Sirf pure-Python packages hi kaam karenge, heavy C-extension libraries fail ho sakti hain.
  - FILE READ/WRITE: Agar user ne is conversation mein koi file attach ki hai, wo sandbox ki current working directory mein uske ORIGINAL filename se already maujood hai — seedha open("filename.ext") se padh sakta hai. Agar code koi nayi file usi current directory mein banaye/save kare (jaise open("output.csv","w")), wo automatically extract ho ke user ko ek download button ki tarah dikha di jaayegi — is se related koi extra JSON field nahi bhejni, bas Python mein file likh dena kaafi hai.
  - Ye action bhi background mein resolve hota hai — bhejne ke baad turant stdout/error (aur agar koi output file bani ho uske naam) ek follow-up message ki tarah milega, phir usi ke base pe user ko final Hinglish answer dena.
  - Jab ye tag bhej raha ho, sirf yahi tag bhej — koi extra chatter mat likh, ye intermediate step hai.
  - Ek response mein sirf ek [ACTION:run_code] bhej.`,
  },
};

// System prompt ke liye saare registered protocols ki sorted, formatted list.
function buildProtocolDocs() {
  const names = Object.keys(PROTOCOLS).sort();
  if (!names.length) return '';
  const blocks = names.map((name) => PROTOCOLS[name].describe).join('\n\n');
  return `\n\nTERE PAAS YE STRUCTURED ACTIONS AVAILABLE HAIN (zaroorat pade tabhi use kar):\n\n${blocks}`;
}

// Reply text ke andar se pehla [ACTION:name]{json}[/ACTION] block dhoondhta hai,
// use text se nikaal (strip) deta hai, aur parsed action { name, payload } return karta hai.
const ACTION_REGEX = /\[ACTION:(\w+)\]([\s\S]*?)\[\/ACTION\]/;

// Model kabhi-kabhi "valid-looking but not quite JSON" bhej deta hai —
// ```json fences ke andar wrap kar dena, smart/curly quotes (“” ‘’ instead
// of "" ''), ya trailing commas. JSON.parse in sab pe seedha fail ho jaata
// hai. Yahan un common gadbadiyo ko normalize karte hain before parsing.
function sanitizeJsonLike(raw) {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1'); // trailing commas
}

function extractAction(text) {
  const match = text.match(ACTION_REGEX);
  if (!match) return { cleanText: text, action: null };

  const [full, name, jsonStr] = match;
  const cleanText = text.replace(full, '').trim();

  if (!PROTOCOLS[name]) {
    // Unknown protocol tag — ignore karo, bas text se hata do taaki user ko raw tag na dikhe.
    return { cleanText, action: null };
  }

  try {
    const payload = JSON.parse(jsonStr.trim());
    return { cleanText, action: { name, payload } };
  } catch (e1) {
    // Pehla attempt fail — common formatting issues clean karke retry karo.
    try {
      const payload = JSON.parse(sanitizeJsonLike(jsonStr));
      return { cleanText, action: { name, payload } };
    } catch (e2) {
      // Ab bhi fail — action drop karo, lekin CHUP mat raho:
      // 1) server logs mein exact raw string daalo taaki wajah pata chale.
      // 2) blank bubble na dikhe isliye cleanText khaali ho to original
      //    text hi fallback ke tor pe wapas de do (raw tag samet), taaki
      //    kam se kam kuch dikhe, kuch nahi se better hai.
      console.error(
        `[extractAction] "${name}" action ka JSON parse fail hua.\nRaw:`,
        jsonStr,
        '\nError:', e2.message
      );
      return { cleanText: cleanText || text, action: null };
    }
  }
}

const TIMEOUT_MS = 12000;
const SEARCH_TIMEOUT_MS = 8000;

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function toOpenAIMessages(messages) {
  return [{ role: 'system', content: SYSTEM_PROMPT + buildProtocolDocs() }, ...messages];
}

async function callOpenAICompatible({ url, key, model, messages, extraHeaders = {} }) {
  return withTimeout(async (signal) => {
    const r = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(messages),
        temperature: 0.7,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from provider');
    return { text, model: data?.model || model };
  }, TIMEOUT_MS);
}

const PROVIDERS = [
  {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    run: (key, messages) =>
      callOpenAICompatible({
        url: 'https://api.groq.com/openai/v1/chat/completions',
        key,
        model: 'openai/gpt-oss-120b',
        messages,
      }),
  },
  {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    run: (key, messages) =>
      callOpenAICompatible({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        key,
        model: 'openrouter/free', // auto-routes to whichever free model is currently up
        messages,
        extraHeaders: {
          'HTTP-Referer': 'https://chaman-ai.vercel.app',
          'X-Title': 'Chaman AI',
        },
      }),
  },
  {
    name: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    run: (key, messages) =>
      callOpenAICompatible({
        url: 'https://api.cerebras.ai/v1/chat/completions',
        key,
        model: 'llama-3.3-70b',
        messages,
      }),
  },
  {
    name: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    run: (key, messages) =>
      callOpenAICompatible({
        url: 'https://api.mistral.ai/v1/chat/completions',
        key,
        model: 'mistral-small-latest',
        messages,
      }),
  },
];

// ── Live Web Search (Tavily) ────────────────────────────────────────
// Pehle DuckDuckGo ka HTML endpoint scrape kiya jaata tha, lekin Vercel/cloud
// IPs se DDG reliably bot-block kar deta tha (0 results / anomaly page) —
// isliye ek proper search API pe switch kiya: Tavily, jo clean JSON deta hai,
// koi scraping/regex nahi chahiye. Free tier: 1000 searches/month, no card.
// Env var chahiye: TAVILY_API_KEY (Vercel → Settings → Environment Variables)

async function performWebSearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY set nahi hai Vercel env vars mein');
  }
  return withTimeout(async (signal) => {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Tavily HTTP ${r.status} — ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
    }));
  }, SEARCH_TIMEOUT_MS);
}

function formatSearchResultsForModel(query, results) {
  if (!results.length) {
    return `[Web search for "${query}" returned no results. Apni knowledge se best-effort answer de, aur agar zaroori ho toh user ko bata de ki live results nahi mile.]`;
  }
  const lines = results.map(
    (r, idx) => `${idx + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
  );
  return `[Web search results for "${query}":]\n${lines.join('\n\n')}\n\n[Inn results ke base pe user ko seedha, natural Hinglish jawab de — kisi bhi line ko word-for-word copy mat kar, apne shabdon mein summarize kar. Relevant ho toh source (site name) mention kar sakta hai.]`;
}

// Provider ko call karta hai, aur agar reply ek web_search action maange toh
// khud search perform karke, results wapas model ko de deta hai — jab tak
// model final (non-search) answer na de de, ya max iterations khatam na ho jaayein.
//
// onStatus(event) — optional callback, jo har live-search phase pe fire hota hai
// (searching / found / search_failed / answering). Isse frontend real-time
// mein "search chal rahi hai" animation dikha sakta hai, sirf baad mein nahi.
const MAX_TOOL_ITERATIONS = 3;

async function runProviderWithActions(provider, key, initialMessages, onStatus) {
  let messages = initialMessages;
  let lastText = '';
  let lastModel = '';
  const emit = typeof onStatus === 'function' ? onStatus : () => {};

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const { text, model } = await provider.run(key, messages);
    lastText = text;
    lastModel = model;

    const { cleanText, action } = extractAction(text);

    if (action && action.name === 'web_search') {
      const query = action.payload && action.payload.query;
      if (!query || typeof query !== 'string') {
        // Malformed search request — jo bhi clean text bacha hai wahi final maan lo.
        return { text: cleanText, model, action: null };
      }

      emit({ phase: 'searching', query });

      let searchNote;
      try {
        const results = await performWebSearch(query);
        emit({ phase: 'found', query, count: results.length });
        searchNote = formatSearchResultsForModel(query, results);
      } catch (err) {
        emit({ phase: 'search_failed', query });
        searchNote = `[Web search for "${query}" fail ho gaya: ${err.message}. Bina live search ke, apni knowledge se best-effort answer de, aur user ko bata de ki abhi live search available nahi tha.]`;
      }

      emit({ phase: 'answering' });

      // Model ka action-call assistant turn ban jaata hai, aur search results
      // agle "user" turn ki tarah feed hote hain — taaki agla model call
      // in results ko dekh ke final answer bana sake.
      messages = [
        ...messages,
        { role: 'assistant', content: text },
        { role: 'user', content: searchNote },
      ];
      continue;
    }

    // Web search nahi maanga gaya — ye hi final answer hai.
    return { text: cleanText, model, action };
  }

  // Max iterations khatam ho gaye (safety net) — jo bhi last mila, usi ko
  // (action tag strip karke) final answer maan ke bhej do.
  const { cleanText, action } = extractAction(lastText);
  return { text: cleanText, model: lastModel, action };
}

// Env var value "key1, key2 ,key3" -> ['key1','key2','key3']
// Ek provider ke multiple keys ho sakte hain (rate-limit/quota spread karne ke liye).
function splitKeys(raw) {
  if (!raw) return [];
  return raw.split(',').map(k => k.trim()).filter(Boolean);
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
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) {
    res.status(400).json({ error: 'messages array chahiye' });
    return;
  }

  // Ab yahan se response ek NDJSON stream hai (ek line = ek JSON event), taaki
  // web_search ke live phases ({type:'status', phase:'searching'|'found'|
  // 'search_failed'|'answering', ...}) turant client tak pahunch sakein — sirf
  // baad mein nahi. Aakhri line hamesha ya toh {type:'final', ...} hoti hai
  // ya {type:'error', ...}. Agar platform buffer kar de (streaming support na
  // ho) toh bhi ye sab lines end mein ek saath aa jaayengi — jawab galat nahi
  // hoga, bas live-animation ka fayda nahi milega.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const write = (event) => res.write(JSON.stringify(event) + '\n');
  const emitStatus = (statusEvent) => write({ type: 'status', ...statusEvent });

  const errors = [];

  for (const provider of PROVIDERS) {
    const keys = splitKeys(process.env[provider.envKey]);
    if (!keys.length) {
      errors.push(`${provider.name}: env var ${provider.envKey} set hi nahi hai (ya khaali hai)`);
      continue; // provider ka koi key hi nahi diya gaya
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      try {
        const { text, model, action } = await runProviderWithActions(provider, key, messages, emitStatus);
        write({ type: 'final', reply: text, provider: provider.name, model, action });
        res.end();
        return;
      } catch (err) {
        errors.push(`${provider.name} (key ${i + 1}/${keys.length}): ${err.message}`);
        // is provider ki agli key try karo; sab keys khatam ho jaye toh agle provider pe jao
      }
    }
  }

  console.error('[chat.js] Sab providers/keys fail ho gaye:\n' + errors.join('\n'));
  write({
    type: 'error',
    error: 'Sab providers/keys fail ho gaye. Env vars check kar Vercel dashboard mein.',
    details: errors,
  });
  res.end();
}
