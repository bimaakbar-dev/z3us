import { persona } from './persona.js';
import { json, logEvent, setStatus, sendMessage, askAI } from './lib.js';

// Format keluaran khusus z3us untuk tugas riset
const FORMAT_RISET = `
Format jawaban (maksimal 5 poin), tiap poin satu baris:
Tema — alasan singkat — perkiraan persaingan (rendah/sedang/tinggi) — ide sudut visual untuk CEO.
Akhiri dengan satu baris: "Catatan: perkiraan dari pengetahuan umum, belum diverifikasi data."`;

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && pathname === '/health') return health(env);
    if (req.method === 'POST' && pathname === '/webhook') return webhook(req, env, ctx);
    if (req.method === 'POST' && pathname === '/task') return taskEndpoint(req, env, ctx);
    return new Response('not found', { status: 404 });
  },
};

// Diagnostik: hanya menampilkan ada/tidaknya konfigurasi, bukan nilainya
function health(env) {
  return json({
    agent: env.AGENT_NAME,
    ok: true,
    bot: env.BOT_USERNAME,
    model: env.MODEL,
    has: {
      BOT_TOKEN: !!env.BOT_TOKEN,
      WEBHOOK_SECRET: !!env.WEBHOOK_SECRET,
      INTERNAL_SECRET: !!env.INTERNAL_SECRET,
      GROQ_API_KEY: !!env.GROQ_API_KEY,
      GEMINI_API_KEY: !!env.GEMINI_API_KEY,
      DB: !!env.DB,
      AI: !!env.AI,
    },
    config: {
      chat_id_valid: /^-100\d+$/.test(String(env.GROUP_CHAT_ID || '')),
      owner_id_valid: /^\d+$/.test(String(env.OWNER_ID || '')) && env.OWNER_ID !== '123456789',
      bot_username_valid: !!env.BOT_USERNAME && !/ganti/i.test(env.BOT_USERNAME),
    },
  });
}

// ---------- Telegram ----------
async function webhook(req, env, ctx) {
  if (!env.WEBHOOK_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
    return new Response('forbidden', { status: 403 });
  const msg = (await req.json()).message;
  if (!msg?.text) return json({ ok: true });

  // hanya grup studio dan hanya CEO
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
  const mine = env.BOT_USERNAME.toLowerCase();
  const lower = msg.text.toLowerCase();
  const replyUser = msg.reply_to_message?.from?.username?.toLowerCase();
  if (!(lower.includes('@' + mine) || replyUser === mine)) return; // hanya jawab kalau dipanggil

  const clean = msg.text.replace(new RegExp('@' + mine, 'ig'), '').trim();
  if (!clean) return sendMessage(env, 'Siap. Mau riset apa?', msg.message_id);

  await setStatus(env, 'thinking');
  await logEvent(env, { type: 'message', status: 'thinking', message: clean.slice(0, 200) });
  try {
    const reply = await askAI(env, persona.system, clean);
    await sendMessage(env, reply, msg.message_id);
    await logEvent(env, { type: 'reply', status: 'idle' });
  } finally {
    await setStatus(env, 'idle');
  }
}

// ---------- Tugas dari k1ng ----------
async function taskEndpoint(req, env, ctx) {
  if (!env.INTERNAL_SECRET || req.headers.get('authorization') !== `Bearer ${env.INTERNAL_SECRET}`)
    return new Response('forbidden', { status: 403 });
  const { task_id } = await req.json();
  ctx.waitUntil(runTask(env, task_id).catch((e) => console.error(e)));
  return json({ accepted: true }, 202);
}

async function runTask(env, id) {
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND assigned_to = ?')
    .bind(id, env.AGENT_NAME).first();
  if (!task) return;
  await env.DB.prepare("UPDATE tasks SET status='in_progress', updated_at=? WHERE id=?").bind(Date.now(), id).run();
  await setStatus(env, 'working');
  await logEvent(env, { type: 'task_start', status: 'working', taskId: id, message: task.title });
  try {
    const result = await askAI(env, persona.system, `Tugas riset: ${task.title}\n\n${task.details || ''}\n${FORMAT_RISET}`);
    await env.DB.prepare("UPDATE tasks SET status='done', result=?, updated_at=? WHERE id=?")
      .bind(result, Date.now(), id).run();
    await sendMessage(env, `✅ ${task.title}\n\n${result}`);
    await logEvent(env, { type: 'task_done', status: 'done', taskId: id, message: task.title });
  } catch (e) {
    await env.DB.prepare("UPDATE tasks SET status='failed', result=?, updated_at=? WHERE id=?")
      .bind(String(e).slice(0, 500), Date.now(), id).run();
    await sendMessage(env, `⚠ Gagal: ${task.title}\n${String(e).slice(0, 200)}`);
    await logEvent(env, { type: 'task_failed', status: 'failed', taskId: id, message: String(e).slice(0, 200) });
  } finally {
    await setStatus(env, 'idle');
  }
}