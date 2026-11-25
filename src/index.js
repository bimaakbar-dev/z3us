import { persona } from './persona.js';
import { json, logEvent, setStatus, sendMessage, askAI, extractJson } from './lib.js';

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && pathname === '/health') return json({ agent: env.AGENT_NAME, ok: true });
    if (req.method === 'POST' && pathname === '/webhook') return webhook(req, env, ctx);
    if (req.method === 'POST' && pathname === '/task') return taskEndpoint(req, env, ctx);
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
    // balas dengan ID yang dilihat bot (hapus DEBUG setelah selesai)
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `DEBUG\nchat=${msg.chat.id}\nfrom=${msg.from?.id}\ncfg_chat=${env.GROUP_CHAT_ID}\ncfg_owner=${env.OWNER_ID}`,
      }),
    });
  }

  // hanya grup studio dan hanya CEO yang boleh memberi perintah
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

  if (!mentioned && !isCoordinator) return; // agent biasa hanya jawab kalau dipanggil

  let agents = [];
  if (isCoordinator) {
    agents = (await env.DB.prepare('SELECT id, username, role, status FROM agents').all()).results;
    if (!mentioned) {
      // pesan tanpa mention -> k1ng, kecuali ditujukan ke agent lain
      const toOthers = agents.some(
        (a) => a.id !== env.AGENT_NAME &&
          (lower.includes('@' + a.username.toLowerCase()) || replyUser === a.username.toLowerCase())
      );
      if (toOthers) return;
    }
  }

  const clean = msg.text.replace(new RegExp('@' + mine, 'ig'), '').trim();

  if (isCoordinator && /^\/status\b/i.test(clean)) {
    const lines = agents.map((a) => `• ${a.id} — ${a.status} (${a.role})`);
    return sendMessage(env, 'Status studio:\n' + lines.join('\n'), msg.message_id);
  }

  await setStatus(env, 'thinking');
  await logEvent(env, { type: 'message', status: 'thinking', message: clean.slice(0, 200) });
  try {
    if (isCoordinator) await coordinate(env, msg, clean, agents);
    else await sendMessage(env, await askAI(env, persona.system, clean), msg.message_id);
    await logEvent(env, { type: 'reply', status: 'idle' });
  } finally {
    await setStatus(env, 'idle');
  }
}

// ---------- Koordinator (k1ng) ----------
async function coordinate(env, msg, text, agents) {
  const team = agents.filter((a) => a.id !== env.AGENT_NAME)
    .map((a) => `- ${a.id}: ${a.role}`).join('\n');
  const system = `${persona.system}

Tim kamu:
${team}

Balas HANYA dengan JSON valid, tanpa teks lain, bentuknya:
{"reply":"jawaban singkat untuk CEO","delegate":[{"to":"<id agent>","title":"judul tugas","details":"instruksi jelas"}]}
"delegate" boleh kosong ([]) jika tidak perlu menugaskan siapa pun. Maksimal 4 tugas.`;

  const raw = await askAI(env, system, text);
  const plan = extractJson(raw) ?? { reply: raw, delegate: [] };

  const lines = [];
  for (const d of (plan.delegate || []).slice(0, 4)) {
    const r = await delegate(env, d, agents);
    if (r) lines.push(`${r.ok ? '→' : '⚠'} @${r.target.username}: ${r.title}${r.ok ? '' : ' (belum aktif)'}`);
  }
  const out = [plan.reply || 'Siap.', ...lines].join('\n\n');
  await sendMessage(env, out, msg.message_id);
}

async function delegate(env, d, agents) {
  const target = agents.find((a) => a.id === d.to && a.id !== env.AGENT_NAME);
  if (!target) return null;
  const title = String(d.title || 'Tugas').slice(0, 200);
  const now = Date.now();
  const res = await env.DB.prepare(
    'INSERT INTO tasks (title, details, assigned_to, created_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(title, String(d.details || '').slice(0, 2000), target.id, env.AGENT_NAME, 'pending', now, now).run();
  const taskId = res.meta.last_row_id;

  let ok = false;
  const binding = env['AGENT_' + target.id.toUpperCase()]; // service binding ke worker agent
  if (binding) {
    try {
      const r = await binding.fetch('https://agent.internal/task', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.INTERNAL_SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ task_id: taskId }),
      });
      ok = r.status === 202;
    } catch (e) { console.error('delegate error', e); }
  }
  if (!ok) {
    await env.DB.prepare("UPDATE tasks SET status='failed', result='agent belum aktif', updated_at=? WHERE id=?")
      .bind(Date.now(), taskId).run();
  }
  await logEvent(env, { type: 'delegate', status: ok ? 'assigned' : 'failed', taskId, message: `${target.id}: ${title}` });
  return { target, title, ok };
}

// ---------- Agent menerima tugas dari k1ng ----------
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
  await env.DB.prepare("UPDATE tasks SET status='in_progress', updated_at=? WHERE id=?").bind(Date.now(), id).run();
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
