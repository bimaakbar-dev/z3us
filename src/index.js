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

  // /status: status dari D1 (offline jika belum di-bind)
  if (isCoordinator && /^\/status\b/i.test(clean)) {
    const lines = agents.map((a) => {
      const bound = a.id === env.AGENT_NAME || !!env['AGENT_' + a.id.toUpperCase()];
      return `• ${a.id} — ${bound ? a.status : 'offline'} (${a.role})`;
    });
    return sendMessage(env, 'Status studio:\n' + lines.join('\n'), msg.message_id);
  }

  // /ping: benar-benar menyentuh tiap agent lewat service binding
  if (isCoordinator && /^\/ping\b/i.test(clean)) {
    const lines = [];
    for (const a of agents.filter((x) => x.id !== env.AGENT_NAME)) {
      const b = env['AGENT_' + a.id.toUpperCase()];
      let s = 'offline (belum di-bind)';
      if (b) {
        try {
          const r = await b.fetch('https://agent.internal/health');
          s = r.ok ? 'online ✅' : `error ${r.status}`;
        } catch {
          s = 'tidak merespons';
        }
      }
      lines.push(`• ${a.id}: ${s}`);
    }
    return sendMessage(env, 'Ping tim:\n' + lines.join('\n'), msg.message_id);
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
    .map((a) => {
      const bound = !!env['AGENT_' + a.id.toUpperCase()];
      const live = !bound ? 'offline' : a.status === 'offline' ? 'idle' : a.status;
      return `- ${a.id}: ${a.role} [status: ${live}]`;
    }).join('\n');

  const system = `${persona.system}

Tim kamu dan status NYATA saat ini:
${team}

Aturan:
- Jangan pernah mengaku agent "aktif" atau "siap" jika statusnya offline. Katakan terus terang bahwa agent itu belum aktif.
- Kamu TIDAK bisa memanggil, menghubungi, atau mengaktifkan agent lewat percakapan. Satu-satunya tindakan nyata adalah mengisi "delegate". Jangan pernah berkata sudah memanggil atau menghubungi tim. Untuk cek koneksi, arahkan CEO ke perintah /ping.
- Kamu tidak tahu sisa kuota atau limit AI. Jangan mengarang angka.
- Delegasikan HANYA jika CEO jelas meminta pekerjaan. Sapaan, pertanyaan status, atau kata "aktifkan" bukan tugas: jawab saja dan kosongkan delegate.
- Pilih hanya agent yang relevan. Jika agent yang tepat offline, jelaskan dan jangan alihkan ke agent lain.
- Jangan mengarang hasil pekerjaan.

Balas HANYA dengan JSON valid, tanpa teks lain, bentuknya:
{"reply":"jawaban singkat untuk CEO","delegate":[{"to":"<id agent>","title":"judul tugas","details":"instruksi jelas"}]}
"delegate" boleh kosong ([]). Maksimal 4 tugas.`;

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

  // agent belum ter-deploy / belum di-bind: jangan buat tugas sampah
  const binding = env['AGENT_' + target.id.toUpperCase()];
  if (!binding) return { target, title, ok: false };

  const now = Date.now();
  const res = await env.DB.prepare(
    'INSERT INTO tasks (title, details, assigned_to, created_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(title, String(d.details || '').slice(0, 2000), target.id, env.AGENT_NAME, 'pending', now, now).run();
  const taskId = res.meta.last_row_id;

  let ok = false;
  try {
    const r = await binding.fetch('https://agent.internal/task', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.INTERNAL_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }),
    });
    ok = r.status === 202;
  } catch (e) {
    console.error('delegate error', e);
  }
  if (!ok) {
    await env.DB.prepare("UPDATE tasks SET status='failed', result='agent tidak merespons', updated_at=? WHERE id=?")
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
