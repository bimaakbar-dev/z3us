export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export async function logEvent(env, { type, status = null, taskId = null, message = null }) {
  await env.DB.prepare(
    'INSERT INTO events (agent, type, status, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(env.AGENT_NAME, type, status, taskId, message, Date.now()).run();
}

export async function setStatus(env, status) {
  await env.DB.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, Date.now(), env.AGENT_NAME).run();
}

export async function sendMessage(env, text, replyTo) {
  const body = { chat_id: env.GROUP_CHAT_ID, text: String(text).slice(0, 4000) };
  if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error('telegram error', r.status, await r.text());
}

// ---------- AI: Groq -> Gemini -> Workers AI (fallback otomatis) ----------
async function viaGroq(env, system, user) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 900,
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return (await r.json()).choices?.[0]?.message?.content?.trim() || '';
}

async function viaGemini(env, system, user) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 900 },
      }),
    }
  );
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const d = await r.json();
  return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

async function viaWorkersAI(env, system, user) {
  const out = await env.AI.run(env.MODEL, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 900,
  });
  const text = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
  return (typeof text === 'object' ? JSON.stringify(text) : String(text)).trim();
}

export async function askAI(env, system, user) {
  const chain = [];
  if (env.GROQ_API_KEY) chain.push(['groq', viaGroq]);
  if (env.GEMINI_API_KEY) chain.push(['gemini', viaGemini]);
  if (env.AI) chain.push(['workers-ai', viaWorkersAI]);
  let lastErr;
  for (const [name, fn] of chain) {
    try {
      const text = await fn(env, system, user);
      if (text) return text;
    } catch (e) {
      lastErr = e;
      console.error('AI gagal:', name, String(e).slice(0, 200));
    }
  }
  throw lastErr || new Error('Tidak ada penyedia AI yang tersedia');
}

export function extractJson(raw) {
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
}
