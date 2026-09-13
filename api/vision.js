// api/vision.js
// Vercel serverless function — image ko NVIDIA NIM ke vision models se
// describe/OCR karwata hai. Chaman AI ka main chat model (Groq gpt-oss-120b
// aur uske fallbacks) text-only hai, image "dekh" nahi sakta — is endpoint
// ka kaam hai image ko dekh ke ek text description/OCR nikaalna, jo phir
// normal chat flow mein context ki tarah inject ho jaata hai (jaise RAG
// knowledge note ya web-search result inject hote hain).
//
// Fallback chain (is exact order mein): moonshotai/kimi-k3 → nvidia/nemotron-
// 3-nano-omni-30b-a3b-reasoning. Ek fail/timeout ho to dusra try hota hai.
//
// Env var chahiye: NVIDIA_API_KEY (Vercel → Settings → Environment Variables)

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const VISION_TIMEOUT_MS = 20000;

// Prompt design: NVIDIA khud decide karta hai ki uska apna jawab user ke
// liye KAAFI hai (pure image description/OCR/simple visual sawaal), ya
// user ko aage real help chahiye jo ek vision model nahi de sakta (code
// fix, multi-step solution, deep reasoning) — us case mein Chaman AI ka
// main text model (jo already coding/reasoning mein strong hai) ko
// involve karna padega. Isse client ko decide karne ki zaroorat nahi
// (keyword-matching jaisa fragile approach) — jisne image dekhi hai wahi
// sabse better judge hai ki uska jawab sufficient hai ya nahi.
//
// Response ke AAKHRI mein ek machine-parseable marker line mangwate hain
// (JSON force karne se zyada reliable hai vision models ke liye — wo
// strict JSON format follow karne mein aksar weak hote hain, ek chhoti
// literal marker line follow karwana zyada robust hai):
//   NEEDS_MAIN_MODEL: yes   → sirf description hi kaafi nahi, user ko
//                             coding/complex-help chahiye jo NVIDIA khud
//                             nahi de sakta
//   NEEDS_MAIN_MODEL: no    → ye description/OCR/answer hi final reply
//                             ke roop mein seedha user ko diya jaa sakta hai
function buildVisionPrompt(userQuestion) {
  const askedPart = userQuestion
    ? `User ne ye bhi poocha hai: "${userQuestion}"\n\n`
    : '';
  return (
    `${askedPart}Is image ko dekh: agar text hai to OCR (verbatim) kar do, aur jo bhi dikh raha hai (objects/scene/diagram/code/error message, etc.) uska description do. Hinglish mein jawab de.\n\n` +
    `Phir decide kar aur AAKHRI line mein bata:\n` +
    `- Agar tera diya description/OCR/jawab hi user ke liye poora/kaafi hai (jaise "iss mein kya hai", "text padh do", simple visual sawaal) → likh: NEEDS_MAIN_MODEL: no\n` +
    `- Agar user ko iske aage REAL help chahiye jo tu khud nahi de sakta — jaise code mein bug fix karna, error solve karna, multi-step solution dena, deep reasoning/planning — → likh: NEEDS_MAIN_MODEL: yes\n` +
    `Is marker line ko EXACTLY isi format mein, response ke bilkul AAKHRI mein likh (\`NEEDS_MAIN_MODEL: yes\` ya \`NEEDS_MAIN_MODEL: no\`) — koi extra text uske baad nahi.`
  );
}

// Model ke response ke aakhir se NEEDS_MAIN_MODEL marker nikaalta hai aur
// use text se strip kar deta hai (taaki user-facing description mein ye
// internal marker kabhi na dikhe). Marker missing/malformed ho (model ne
// format follow nahi kiya) to safe default `true` maanta hai — matlab
// "main model ko involve karo" — kyunki galti se short-circuit karke user
// ko incomplete help dena, galti se ek extra step lagne se zyada bura hai.
const NEEDS_MAIN_MODEL_REGEX = /\n?NEEDS_MAIN_MODEL:\s*(yes|no)\s*$/i;

function extractNeedsMainModel(rawText) {
  const match = rawText.match(NEEDS_MAIN_MODEL_REGEX);
  if (!match) {
    return { description: rawText.trim(), needsMainModel: true };
  }
  const description = rawText.slice(0, match.index).trim();
  const needsMainModel = match[1].toLowerCase() === 'yes';
  return { description, needsMainModel };
}

const VISION_MODELS = [
  {
    name: 'kimi-k3',
    model: 'moonshotai/kimi-k3',
    // kimi-k3 hamesha reasoning-on rehta hai; max ke bajaye "low" rakha hai
    // taaki ek simple OCR/description task ke liye bhi zyada der na lage.
    extraBody: { reasoning_effort: 'low' },
  },
  {
    name: 'nemotron-3-nano-omni',
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    extraBody: { reasoning_budget: 4096 },
  },
];

async function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

// dataUrl shape expect karta hai: "data:image/png;base64,AAAA..." (jaisa
// frontend ka FileReader.readAsDataURL seedha deta hai) YA sirf raw base64
// (agar caller ne pehle hi prefix strip kar diya ho) — dono handle karta hai.
function toImageDataUrl(imageBase64, mimeType) {
  if (imageBase64.startsWith('data:')) return imageBase64;
  const mime = mimeType || 'image/jpeg';
  return `data:${mime};base64,${imageBase64}`;
}

async function callVisionModel(entry, apiKey, imageDataUrl, question) {
  return withTimeout(async (signal) => {
    const r = await fetch(NVIDIA_URL, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: entry.model,
        stream: false,
        temperature: 0.4,
        max_tokens: 2048,
        ...entry.extraBody,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildVisionPrompt(question) },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    const rawText = data?.choices?.[0]?.message?.content;
    if (!rawText || typeof rawText !== 'string') throw new Error('Empty response from NVIDIA NIM');
    const { description, needsMainModel } = extractNeedsMainModel(rawText);
    if (!description) throw new Error('Empty description after stripping marker');
    return { description, needsMainModel, model: entry.name };
  }, VISION_TIMEOUT_MS);
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

  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : '';
  const question = typeof body?.question === 'string' ? body.question : '';

  if (!imageBase64.trim()) {
    res.status(400).json({ ok: false, error: 'imageBase64 chahiye' });
    return;
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: 'NVIDIA_API_KEY set nahi hai Vercel env vars mein' });
    return;
  }

  const imageDataUrl = toImageDataUrl(imageBase64, mimeType);
  const errors = [];

  for (const entry of VISION_MODELS) {
    try {
      const { description, needsMainModel, model } = await callVisionModel(entry, apiKey, imageDataUrl, question);
      res.json({ ok: true, description, needsMainModel, model });
      return;
    } catch (err) {
      errors.push(`${entry.name}: ${err.message}`);
      // agla model try karo (kimi-k3 fail ho to nemotron try hoga)
    }
  }

  console.error('[vision.js] Dono NVIDIA vision models fail ho gaye:\n' + errors.join('\n'));
  res.status(502).json({
    ok: false,
    error: 'Image analyze nahi ho payi — dono NVIDIA models fail ho gaye.',
    details: errors,
  });
}
