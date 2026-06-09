// rag.js — bilingual (English + Nepali) Retrieval-Augmented Generation over local
// Ollama, with conversation memory and an agentic clarifying-question flow.
//
// • Same-language retrieval: Nepali queries search the Nepali chunks, English the
//   English chunks (best practice for a low-resource language like Nepali).
// • Memory: uses Ollama /api/chat with a rolling message history, and builds the
//   retrieval query from recent turns so follow-ups stay on topic.
// • Generation language follows the UI toggle (answers in Nepali when ne).

import { KB } from './knowledge.js';
import { getLastResult } from './store.js';

const OLLAMA_URL = (typeof window !== 'undefined' && window.HARIT_OLLAMA) || 'http://localhost:11434';
const EMBED_MODEL = (typeof window !== 'undefined' && window.HARIT_EMBED) || 'nomic-embed-text';

const PERSONA = {
  en: "You are Bana, a warm, encouraging red panda who helps Nepali school students (Grade 6-10) act on climate change. Be specific to Nepal, simple and friendly, never preachy. ",
  ne: "तपाईं बाना हुनुहुन्छ — नेपालका विद्यार्थी (कक्षा ६-१०) लाई जलवायु कार्यमा सघाउने न्यानो, उत्साही रातो पाण्डा। नेपाल-केन्द्रित, सरल र मैत्रीपूर्ण हुनुहोस्। ",
};
const LANG_RULE = {
  en: 'Reply in clear, simple English. ',
  ne: 'जवाफ सधैं सरल नेपाली (देवनागरी लिपि) मा मात्र दिनुहोस्। अङ्ग्रेजी प्रयोग नगर्नुहोस्। ',
};
const CAT_LABEL = { transport: { en: 'transport', ne: 'यातायात' }, electricity_home: { en: 'home electricity', ne: 'घरको बिजुली' }, cooking: { en: 'cooking fuel', ne: 'खाना पकाउने इन्धन' }, food: { en: 'food', ne: 'खाना' }, waste: { en: 'waste', ne: 'फोहोर' }, water: { en: 'water', ne: 'पानी' }, electricity_school: { en: 'school electricity', ne: 'स्कुलको बिजुली' } };

function calcContext(lang) {
  const r = getLastResult();
  if (!r || !r.breakdown) return '';
  const top = Object.entries(r.breakdown).filter(([k]) => k !== 'carbon_sink' && CAT_LABEL[k]).sort((a, b) => b[1] - a[1])[0];
  if (!top) return '';
  const cat = CAT_LABEL[top[0]][lang];
  return lang === 'ne'
    ? `यो विद्यार्थीको नापिएको फुटप्रिन्ट दैनिक करिब ${r.daily} किलो CO2 (इको स्कोर ${r.ecoScore}/100) छ, र सबैभन्दा ठूलो स्रोत ${cat} हो। पहिले त्यही घटाउन सल्लाह दिनुहोस्।`
    : `Their measured footprint is about ${r.daily} kg CO2/day (eco score ${r.ecoScore}/100); their biggest source is ${cat}. Tailor advice to lower that first.`;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { const res = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(t); return res; }
  catch (_) { clearTimeout(t); return null; }
}

export async function pickChatModel() {
  const res = await fetchWithTimeout(OLLAMA_URL + '/api/tags', { method: 'GET' }, 3500);
  if (!res || !res.ok) { console.warn('[Bana RAG] Cannot reach Ollama at ' + OLLAMA_URL + ' (running? OLLAMA_ORIGINS set?).'); return null; }
  let data; try { data = await res.json(); } catch (_) { return null; }
  const names = (data.models || []).map((m) => m.name || '');
  if (!names.length) { console.warn('[Bana RAG] No models. Run: ollama pull llama3.2'); return null; }
  const chat = names.find((n) => n.startsWith('bana')) || names.find((n) => n.startsWith('llama3.2')) || names.find((n) => n.startsWith('llama')) || names.find((n) => !n.includes('embed')) || names[0];
  console.info('[Bana RAG] chat model: ' + chat + ' | embeddings ' + (names.some((n) => n.includes('embed')) ? 'available' : 'NOT installed (keyword fallback)'));
  return chat;
}

async function embedTexts(texts) {
  let res = await fetchWithTimeout(OLLAMA_URL + '/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input: texts }) }, 60000);
  if (res && res.ok) { try { const d = await res.json(); if (d.embeddings && d.embeddings.length) return d.embeddings; } catch (_) { /* */ } }
  const out = [];
  for (const t of texts) {
    res = await fetchWithTimeout(OLLAMA_URL + '/api/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, prompt: t }) }, 20000);
    if (!res || !res.ok) return null;
    try { const d = await res.json(); if (!d.embedding) return null; out.push(d.embedding); } catch (_) { return null; }
  }
  return out;
}

function cosine(a, b) { let dot = 0; let na = 0; let nb = 0; for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8); }
const STOP = new Set('a an the to of in on for and or is are be my your you i how do can what why where when which with as at it its this that some more less most help me make plan'.split(' '));
function tokenize(s) { return (s.toLowerCase().match(/[a-z0-9\u0900-\u097f]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w)); }
function keywordScore(qTokens, chunk, lang) {
  const hay = (chunk[lang].title + ' ' + chunk.tags.join(' ') + ' ' + chunk[lang].text + ' ' + chunk.en.title).toLowerCase();
  const tagstr = chunk.tags.join(' ').toLowerCase();
  let hits = 0;
  qTokens.forEach((w) => { if (hay.includes(w)) hits += tagstr.includes(w) ? 2 : 1; });
  return hits / (qTokens.length * 2 + 1);
}

const INDEX = { en: null, ne: null };
export async function buildIndex(lang = 'en') {
  if (INDEX[lang]) return INDEX[lang];
  const texts = KB.map((c) => `${c[lang].title}. ${c[lang].text} ${c.tags.join(', ')}`);
  const vecs = await embedTexts(texts).catch(() => null);
  INDEX[lang] = { mode: vecs ? 'vector' : 'keyword', vecs };
  console.info(`[Bana RAG] ${lang} index built in ${INDEX[lang].mode} mode (${KB.length} chunks).`);
  return INDEX[lang];
}

export async function retrieve(query, lang = 'en', k = 4) {
  const idx = await buildIndex(lang);
  const qTokens = tokenize(query);
  let scored;
  if (idx.mode === 'vector') {
    const qv = await embedTexts([query]);
    if (qv && qv[0]) scored = KB.map((c, i) => ({ c, s: cosine(qv[0], idx.vecs[i]) + 0.15 * keywordScore(qTokens, c, lang) }));
  }
  if (!scored) scored = KB.map((c) => ({ c, s: keywordScore(qTokens, c, lang) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.c);
}

// streaming chat with memory via /api/chat
export async function streamChat({ model, messages, onToken }) {
  const res = await fetchWithTimeout(OLLAMA_URL + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, stream: true, keep_alive: '10m', options: { temperature: 0.6, num_predict: 380 } }) }, 60000);
  if (!res || !res.ok || !res.body) { if (res) console.warn('[Bana RAG] chat HTTP ' + res.status); return null; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let full = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) { const s = line.trim(); if (!s) continue; try { const o = JSON.parse(s); const tok = o.message && o.message.content; if (tok) { full += tok; if (onToken) onToken(tok); } } catch (_) { /* */ } }
  }
  return full.trim() || null;
}

function contextBlock(chunks, lang) { return chunks.map((c, i) => `[${i + 1}] ${c[lang].title}\n${c[lang].text}`).join('\n\n'); }
const NOTEBOOK = { en: 'NOTEBOOK', ne: 'नोटबुक' };

// build the retrieval query from the recent conversation so follow-ups stay on topic
function retrievalQuery(query, history) {
  const lastUser = [...(history || [])].reverse().find((m) => m.role === 'user');
  return ((lastUser ? lastUser.content + ' ' : '') + query).slice(0, 400);
}

export async function answerQuestion({ model, query, history = [], lang = 'en', onToken }) {
  const chunks = await retrieve(retrievalQuery(query, history), lang, 4);
  const ctx = calcContext(lang);
  const sys = PERSONA[lang] + LANG_RULE[lang]
    + (lang === 'ne'
      ? `तलको ${NOTEBOOK.ne} का तथ्यमा मात्र आधारित भएर ९० शब्दभित्र जवाफ दिनुहोस्। नोटबुकमा नभए छोटोमा भन्नुहोस् र सुरक्षित सामान्य नेपाल सल्लाह दिनुहोस्। यो हप्ता गर्न सकिने एउटा ठोस सुझावले अन्त्य गर्नुहोस्। अघिल्लो कुराकानीलाई ध्यानमा राख्नुहोस्।`
      : `Answer using ONLY the facts in the ${NOTEBOOK.en} below, under 90 words. If it is not covered, say so briefly and give safe general Nepal advice. End with one specific tip for this week. Use the earlier conversation for context.`);
  const userMsg = `${NOTEBOOK[lang]}:\n${contextBlock(chunks, lang)}\n${ctx ? '\n' + ctx + '\n' : ''}\n${lang === 'ne' ? 'प्रश्न' : 'Question'}: ${query}`;
  const messages = [{ role: 'system', content: sys }, ...history.slice(-8), { role: 'user', content: userMsg }];
  const text = await streamChat({ model, messages, onToken });
  return { text, sources: chunks };
}

export async function makePlan({ model, answers, modifier, history = [], lang = 'en', onToken }) {
  const ctx = calcContext(lang);
  const rq = `${answers.focus || ''} ${answers.detail || ''} ${answers.area || ''} reduce carbon footprint plan Nepal`;
  const chunks = await retrieve(rq, lang, 5);
  const profile = lang === 'ne'
    ? `विद्यार्थी बस्ने ठाउँ: ${answers.area}. पहिले सुधार्ने: ${answers.focus}.${answers.detail ? ' विवरण: ' + answers.detail + '.' : ''}${modifier ? ' विशेष अनुरोध: ' + modifier + '.' : ''}`
    : `Lives in: ${answers.area}. Focus first: ${answers.focus}.${answers.detail ? ' Detail: ' + answers.detail + '.' : ''}${modifier ? ' Special request: ' + modifier + '.' : ''}`;
  const sys = PERSONA[lang] + LANG_RULE[lang]
    + (lang === 'ne'
      ? `तलको नोटबुकका तथ्य मात्र प्रयोग गरी यो विद्यार्थीका लागि नेपाल-केन्द्रित कार्ययोजना बनाउनुहोस्। ढाँचा: एक न्यानो वाक्य, त्यसपछि ३-४ नम्बरित कदम (ठाउँ, फोकस र विवरण अनुसार), प्रत्येकमा करिब कति मद्दत गर्छ। १७० शब्दभित्र राख्नुहोस् र उत्साहजनक वाक्यले अन्त्य गर्नुहोस्।`
      : `Using ONLY the notebook facts, create a Nepal-specific action plan for this student. Format: one warm sentence, then 3-4 numbered steps tailored to their area, focus and detail, each with roughly how much it helps. Keep under 170 words and end with encouragement.`);
  const userMsg = `${NOTEBOOK[lang]}:\n${contextBlock(chunks, lang)}\n${ctx ? '\n' + ctx + '\n' : ''}\n${lang === 'ne' ? 'विद्यार्थी विवरण' : 'Student profile'}: ${profile}`;
  const messages = [{ role: 'system', content: sys }, ...history.slice(-8), { role: 'user', content: userMsg }];
  const text = await streamChat({ model, messages, onToken });
  return { text, sources: chunks };
}

// intent detection (English + Nepali keywords)
export function isPlanIntent(text) {
  return /\b(reduce|lower|cut|less|plan|start|begin|improve|help me|how (do|can|should) i|what (should|can) i do|go green|footprint|greener)\b/i.test(text)
    || /(घटा|कम गर|कम गर्न|योजना|सुरु|कसरी|मद्दत|हरित|फुटप्रिन्ट|सुधार)/.test(text);
}
export function isAmbiguous(text) {
  const t = text.trim();
  if (/[?？]/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  return /\b(transport|travel|cooking|fuel|food|waste|plastic|energy|electricity|water|trees|forest|solar|ev|bus)\b/i.test(t)
    || /(यातायात|यात्रा|खाना|इन्धन|फोहोर|प्लास्टिक|ऊर्जा|बिजुली|पानी|रूख|वन|सौर्य|बस)/.test(t);
}
// map a topic word (any language) to a focus label key
export const TOPIC_TO_FOCUS = {
  transport: 'transport', travel: 'transport', bus: 'transport', ev: 'transport', यातायात: 'transport', यात्रा: 'transport', बस: 'transport',
  cooking: 'cooking', fuel: 'cooking', energy: 'cooking', electricity: 'cooking', solar: 'cooking', इन्धन: 'cooking', ऊर्जा: 'cooking', बिजुली: 'cooking', सौर्य: 'cooking',
  food: 'food', खाना: 'food', waste: 'waste', plastic: 'waste', फोहोर: 'waste', प्लास्टिक: 'waste',
};
