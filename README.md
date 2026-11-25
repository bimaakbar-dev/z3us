# Studio agent (template)

Satu repo = satu bot = satu Cloudflare Worker. Semua agent berbagi satu D1 (`studio`).

## Membuat agent baru dari template
1. Salin `personas/<nama>.js` ke `src/persona.js`.
2. Edit `wrangler.toml`: name, AGENT_NAME, BOT_USERNAME, GROUP_CHAT_ID, OWNER_ID, database_id.
3. @BotFather: `/newbot`, lalu `/setprivacy` -> Disable. Masukkan bot ke grup (kalau privacy diubah belakangan, keluarkan dan masukkan lagi).
4. Secret (nilai INTERNAL_SECRET harus SAMA di semua repo):
   `npx wrangler secret put BOT_TOKEN` / `WEBHOOK_SECRET` / `INTERNAL_SECRET`
5. `npm i && npx wrangler deploy`
6. Pasang webhook:
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d url=https://<worker>.<subdomain>.workers.dev/webhook -d secret_token=<WEBHOOK_SECRET>`

## Sekali saja (dari repo k1ng)
```
npx wrangler d1 create studio          # salin database_id ke wrangler.toml semua repo
npx wrangler d1 execute studio --remote --file=schema.sql
```
Sesuaikan kolom `username` di tabel agents dengan username bot sebenarnya:
`npx wrangler d1 execute studio --remote --command "UPDATE agents SET username='...' WHERE id='z3us'"`

## Urutan deploy
Deploy agent biasa dulu, baru buka komentar service binding-nya di wrangler.toml k1ng.
Binding ke worker yang belum ada akan membuat deploy k1ng gagal.

## Perintah di grup
- Pesan biasa -> k1ng menjawab / mendelegasikan
- `@username_bot ...` atau reply ke pesan bot -> agent itu yang menjawab
- `/status` -> daftar status semua agent
