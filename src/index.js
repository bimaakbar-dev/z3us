import { persona } from './persona.js';
import { json, logEvent, setStatus, sendMessage, askAI } from './lib.js';

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && pathname === '/health')
      return json({ agent: env.AGENT_NAME, ok: true });
    if (req.method === 'POST' && pathname === '/webhook')
      return webhook(req, env, ctx);
    if (req.method === 'POST' && pathname === '/task')
      return taskEndpoint(req, env, ctx);
    return new Response('not found', { status: 404 });
  },
};

// ---------- Telegram ----------
async function webhook(req, env, ctx) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
    return new Response('forbidden', { status: 403 });
  const msg = (await req.json()).message;
  if (!msg?.text) return json({ ok: true });

  if (env.DEBUG === 'true') {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `DEBUG\nchat=${msg.chat.id}\nfrom=${msg.from?.id}\ncfg_chat=${env.GROUP_CHAT_ID}\ncfg_owner=${env.OWNER_ID}`,
      }),
    });
  }

  if (String(msg.chat.id) !== String(env.GROUP_CHAT_ID) || String(msg.from?.id) !== String(env.OWNER_ID))
    return json({ ok: true });

  ctx.waitUntil(
    handleMessage(env, msg).catch((e) => {
      console.error(e);
      return sendMessage(env, '⚠ Error: ' + String(e).slice(0, 300), msg.message_id).catch(() => {});
    })
  );
  return json({ ok: true });
}

async function handleMessage(env, msg) {
  const isCoordinator = env.IS_COORDINATOR === 'true';
  const mine = env.BOT_USERNAME.toLowerCase();
  const lower = msg.text.toLowerCase();
  const replyUser = msg.reply_to_message?.from?.username?.toLowerCase();
  const mentioned = lower.includes('@' + mine) || replyUser === mine;

  if (!mentioned && !isCoordinator) return;

  const clean = msg.text.replace(new RegExp('@' + mine, 'ig'), '').trim();

  await setStatus(env, 'thinking');
  await logEvent(env, { type: 'message', status: 'thinking', message: clean.slice(0, 200) });
  try {
    await sendMessage(env, await askAI(env, persona.system, clean), msg.message_id);
    await logEvent(env, { type: 'reply', status: 'idle' });
  } finally {
    await setStatus(env, 'idle');
  }
}

// ---------- Agen menerima tugas dari k1ng (koordinator) ----------
async function taskEndpoint(req, env, ctx) {
  if (req.headers.get('authorization') !== `Bearer ${env.INTERNAL_SECRET}`)
    return new Response('forbidden', { status: 403 });
  const { task_id } = await req.json();
  ctx.waitUntil(runTask(env, task_id).catch((e) => console.error(e)));
  return json({ accepted: true }, 202);
}

async function runTask(env, id) {
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND assigned_to = ?')
    .bind(id, env.AGENT_NAME).first();
  if (!task) return;
  await env.DB.prepare("UPDATE tasks SET status='in_progress', updated_at=? WHERE id=?")
    .bind(Date.now(), id).run();
  await setStatus(env, 'working');
  await logEvent(env, { type: 'task_start', status: 'working', taskId: id, message: task.title });
  try {
    const result = await askAI(env, persona.system, `Tugas: ${task.title}\n\n${task.details || ''}`);
    await env.DB.prepare("UPDATE tasks SET status='done', result=?, updated_at=? WHERE id=?")
      .bind(result, Date.now(), id).run();
    await sendMessage(env, `✅ ${task.title}\n\n${result}`);
    await logEvent(env, { type: 'task_done', status: 'done', taskId: id, message: task.title });
  } catch (e) {
    await env.DB.prepare("UPDATE tasks SET status='failed', result=?, updated_at=? WHERE id=?")
      .bind(String(e).slice(0, 500), Date.now(), id).run();
    await sendMessage(env, `⚠ Gagal: ${task.title}`);
    await logEvent(env, { type: 'task_failed', status: 'failed', taskId: id, message: String(e).slice(0, 200) });
  } finally {
    await setStatus(env, 'idle');
  }
}
