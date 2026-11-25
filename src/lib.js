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

export async function askAI(env, system, user) {
  const out = await env.AI.run(env.MODEL, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 900,
  });
  return String(out.response || '').trim();
}

export function extractJson(raw) {
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
}
