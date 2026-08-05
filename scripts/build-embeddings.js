// scripts/build-embeddings.js
// LOCAL script — Vercel pe deploy nahi hoti, khud terminal se chalao:
//   GEMINI_API_KEY=xxx node scripts/build-embeddings.js
//
// knowledge/*.md padhta hai, har "## Heading" section ko ek chunk banata hai,
// Gemini embedding API se vector banata hai, aur sab kuch
// api/_knowledge-embeddings.json mein save kar deta hai — jo api/chat.js
// runtime par sirf READ karta hai (koi live embedding-of-knowledge nahi
// hoti, sirf query embed hoti hai — isliye ye script har baar knowledge
// change karne par manually rerun karna padega).

const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY env var chahiye. Free key: https://aistudio.google.com/apikey');
  process.exit(1);
}

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');
const OUTPUT_PATH = path.join(__dirname, '..', 'api', '_knowledge-embeddings.json');
const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

// Har "## Heading" ek naya chunk shuru karta hai. Heading ka text khud bhi
// chunk content mein rehta hai (context ke liye), taaki embedding ko pata
// ho ye chunk kis topic ka hai.
function chunkMarkdown(text, sourceFile) {
  const lines = text.split('\n');
  const chunks = [];
  let current = null;
  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (current && current.body.trim()) chunks.push(current);
      current = { title: headingMatch[1].trim(), body: line + '\n', source: sourceFile };
    } else if (current) {
      // HTML comments (<!-- ... -->) skip — wo sirf humans ke liye instructions hain
      if (line.trim().startsWith('<!--') || line.trim().endsWith('-->')) continue;
      current.body += line + '\n';
    }
  }
  if (current && current.body.trim()) chunks.push(current);
  return chunks;
}

async function embed(text) {
  const resp = await fetch(`${EMBED_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_DOCUMENT',
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gemini embed HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values)) throw new Error('Gemini response mein embedding.values nahi mila');
  return values;
}

async function main() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.error(`knowledge/ folder nahi mila (${KNOWLEDGE_DIR}). Pehle knowledge/*.md files banao.`);
    process.exit(1);
  }

  const files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith('.md'));
  if (!files.length) {
    console.error('knowledge/ mein koi .md file nahi mili.');
    process.exit(1);
  }

  let allChunks = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
    allChunks = allChunks.concat(chunkMarkdown(text, file));
  }

  console.log(`${files.length} file(s) se ${allChunks.length} chunks mile. Embedding shuru...`);

  const results = [];
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    process.stdout.write(`  [${i + 1}/${allChunks.length}] ${chunk.title}... `);
    try {
      const vector = await embed(chunk.body.trim());
      results.push({ title: chunk.title, text: chunk.body.trim(), source: chunk.source, vector });
      console.log('ok');
    } catch (err) {
      console.log('FAILED — ' + err.message);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ builtAt: new Date().toISOString(), chunks: results }, null, 2));
  console.log(`\nDone — ${results.length}/${allChunks.length} chunks saved to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log('Ab is file ko commit karke deploy karo — api/chat.js isse runtime par load karega.');
}

main().catch((err) => {
  console.error('Build fail hua:', err);
  process.exit(1);
});
