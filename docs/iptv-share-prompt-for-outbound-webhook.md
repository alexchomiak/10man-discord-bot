# Prompt for the other agent: Add an outbound "bot trigger" webhook to iptv-share

> Hand this to a coding agent with read/write access to the `/Users/alexchomiak/code/iptv-share` repo.
> Scope is narrow: add a **new machine-to-machine webhook** to iptv-share that the 10-man-discord-bot's selfbot will consume.
> The selfbot side (consumer) is already implemented in a separate repo. This prompt is only for the sender side.

## Context

Today, `iptv-share` POSTs to a **Discord channel webhook** on `static_shares.discord_webhook_url` when a static share's scheduled event is about to start, when it ends, when the score updates, etc. See existing code:

- `src/server/index.js` line ~2229: `sendDiscordWebhook(webhookUrl, { content, embed })` — POSTs a Discord-channel-webhook-shaped body to a Discord channel URL.
- `sendDiscordWebhookOnce` / `claimDelivery` / `releaseDelivery` — dedupe via `discord_webhook_deliveries`.
- `runDiscordWebhookTick` — the tick that triggers the above per static-share-event.
- `publicShareUrl({slug})` at line ~75 — builds the public share URL.
- `POST /api/shares` (line ~1656) and `POST /api/static-shares` (line ~1722) — admin creation endpoints (where `discord_webhook_url` currently lives on the share row).
- Static-share admin UI: `src/client/src/components/admin/AdminSharePage.jsx`.

**What we want:** add a *separate* "bot trigger" outbound webhook. It is NOT a replacement for the existing Discord-channel webhook. It is an *additive* feature:

1. On a static share, store an optional `bot_webhook_url` (machine endpoint, e.g. `http://streambot:8081/webhook/stream` in-docker or `https://streambot.internal/webhook/stream`) **and** an optional `bot_webhook_secret`.
2. When a share event becomes "streamable" (i.e. when the existing `sendDiscordWebhookOnce(reminderKey, …)` would have fired the "starts in ~15 min" reminder, OR when `findActiveStaticEvent` first reports streamable), also fire the bot trigger webhook — POST to `bot_webhook_url` with a structured body and an HMAC header.
3. The bot trigger is idempotent: only fire it once per event per direction (start / stop), using the existing `discord_webhook_deliveries` table (with a distinct `delivery_key` like `bot:trigger:start:<shareId>:<eventId>` / `bot:trigger:stop:...`). Do NOT reuse the existing Discord-channel keys.
4. Keep the legacy `discord_webhook_url` path untouched.

## The bot's expected request (already implemented on the consumer side)

The bot endpoint is `POST /webhook/stream` on `http://<host>:8081` (or whatever URL the admin sets).

**Auth (REQUIRED for all stream POSTs):**
- Header: `x-webhook-secret: <hex>` where `<hex> = HMAC_SHA256(bot_webhook_secret, rawBody)`. The bot compares via `crypto.timingSafeEqual` on the hex digest. Case-insensitive hex. 64-char hex or base64 of 32 bytes.
- If `WEBHOOK_SECRET` is not set on the bot, the bot refuses the request with HTTP 503. So: always set a secret on both sides.

**Body — two accepted shapes (bot handles either; pick one to send). Use the structured one as the canonical contract:**

```json
{
  "share_slug": "<slug from iptv-share>",
  "title": "<optional human title>",
  "guild_id": "<optional>",
  "channel_id": "<optional>"
}
```
- `share_slug` alone is enough; the bot will call `GET {SHARETV_BASE}/api/public/share/{slug}` to resolve the playable URL.
- `stream_url` is an alternative: if iptv-share already knows a direct playable media URL (e.g. the upstream `channels.stream_url` or a signed stream URL it can build), it may send `stream_url` directly and skip slug resolution. The bot prefers `stream_url` over `share_slug` when both are present.

If iptv-share wants to stay backwards-compatible with older bot builds, it may also send the current Discord-webhook-shaped body:
```json
{
  "username": "ShareTV",
  "content": "<line 1>\nhttps://sharetv.example.com/s/<slug>",
  "embeds": [{ "title": "...", "url": "https://sharetv.example.com/s/<slug>" }]
}
```
The bot extracts the first http(s) URL from `embeds[0].url` (or `content`) and runs it through the same resolver.

**Expected response from the bot:**
- `200 {"ok":true,"kind":"sharetv","title":"…","channel_id":"…","note":"streaming started"}`
- `401` — bad/missing `x-webhook-secret` (the bot will not stream; log the 401 and surface it in the admin UI if you expose delivery status)
- `400` — bad JSON, no source, no channel/guild
- `502` — source not streamable right now (`note` explains), or `streamManager.start` failed
- `500` — internal
- `503` — webhook disabled on the bot side (secret unset) — iptv-share should treat this as "bot not configured", not an error (log + continue)

## iptv-share side: exact changes required

### 1. `STATIC_SHARES` table
- Add column `bot_webhook_url TEXT` (nullable, empty = disabled).
- Add column `bot_webhook_secret TEXT` (nullable, empty = disabled; if present, always HMAC).
- In `src/server/db.js` `ensureColumns`, add the two new columns with `ensureColumn("static_shares", "bot_webhook_url", "TEXT")` and `ensureColumn("static_shares", "bot_webhook_secret", "TEXT")`. Do NOT rename or drop the existing `discord_webhook_url` column.

### 2. `POST /api/static-shares` (line ~1722)
- Accept `bot_webhook_url` and `bot_webhook_secret` in the JSON body.
- Store them.
- Do not change existing behavior for `discord_webhook_url`.

### 3. `GET /api/static-shares/:id` and the admin list endpoint (line ~2221)
- Return `bot_webhook_url` (never the secret; if a secret is set, return `has_bot_webhook_secret: true` and the URL; never the secret value itself).
- Admin UI: add two fields to `AdminSharePage.jsx`: "Bot webhook URL" (text) and "Bot webhook secret" (password, with a "Generate" button that calls `openssl`-equivalent via a new `POST /api/static-shares/:id/regenerate-bot-secret` endpoint that returns a fresh `crypto.randomBytes(32).toString('hex')`). Also a small "Test" button that does a dry-run POST to the configured bot URL with a `dry_run: true` flag in the body and shows the bot's response.

### 4. `sendDiscordWebhookOnce` → add a sibling (do NOT change the existing one)
Create `botWebhookSend(share, eventId, direction, payload)`:
- If `!share.bot_webhook_url` → no-op, return `false`.
- If `!share.bot_webhook_secret` → no-op, warn in logs once per share per hour.
- `claimDelivery(`bot:trigger:${direction}:${share.id}:${eventId}`, share.id, eventId)` to dedupe.
- Build the body:
  ```js
  const body = {
    share_slug: share.slug,
    title: share.title || `Static share ${share.slug}`,
    guild_id: null,   // or share-level override if you add one
    channel_id: null, // or share-level override if you add one
  };
  ```
  If `stream_url` is known (e.g. the upstream `event.stream_url`), you MAY also add `stream_url` to the body — the bot will prefer it. Both shapes are fine.
- Compute `hex = crypto.createHmac('sha256', share.bot_webhook_secret).update(JSON.stringify(body)).digest('hex')` — must be **the exact same raw** body (no `JSON.stringify` re-ordering; use a stable stringify; the bot compares the HMAC of the raw bytes it received, as long as iptv-share uses the same byte string the server sends on the wire).
- `fetch(share.bot_webhook_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': hex, 'user-agent': 'iptv-share/0.2' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })`.
- If response is 200 → `return true`. If 401 → do NOT retry; log the share id and surface in admin UI. If 503 → no-op (bot not configured). Other → throw (caller will release the delivery key on error).
- On throw, `releaseDelivery(key, shareId, eventId)` (existing helper) so a later tick can retry.

### 5. Trigger points
Call `botWebhookSend(share, eventId, 'start', { … })` at the same sites where the existing "starts in ~15 min" reminder is sent in `runDiscordWebhookTick` (line ~2361). Do NOT change the existing reminder logic; just fire the bot trigger alongside it.

Call `botWebhookSend(share, eventId, 'stop', { … })` when the event's `ends_at + shareAutoDeleteSeconds` has passed (i.e. the existing final/close path at line ~2384). Use the same delivery-dedupe pattern.

### 6. Do NOT
- Do not rename `discord_webhook_url` or the existing `discord_webhook_deliveries` rows.
- Do not change the existing `sendDiscordWebhook` payload shape.
- Do not log `bot_webhook_secret` anywhere (not in `console.log`, not in the admin JSON response, not in the `discord_webhook_deliveries` table). Redact it in any error string.
- Do not require the bot to be reachable in order to create or update a static share. A missing bot webhook URL must never block share creation.
- Do not add new runtime deps. `node:crypto`, `node:fetch` (Node 18+), `AbortSignal.timeout` are all built-in on Node 18/20/22.

## Acceptance tests (the agent must write and run these in `iptv-share/test/`)

1. **Schema:** a new `static_shares` row can be created with `bot_webhook_url` and `bot_webhook_secret` set; the row reads back. The existing `discord_webhook_url` path still works.
2. **HMAC:** given a known secret + body, the hex in the `x-webhook-secret` header equals `sha256(secret, body)` hex digest.
3. **Dedupe:** firing the same `(share, event, 'start')` trigger 3 times results in exactly 1 HTTP POST (assert by counting fetches with a stubbed global fetch).
4. **Retry on 5xx:** a 500 response releases the delivery key; the next tick re-fires.
5. **Silence on 503:** a 503 response does not retry and does not log an error.
6. **No leak:** admin JSON response for a share with `bot_webhook_secret` set does NOT contain the secret; `has_bot_webhook_secret: true` is present.
7. **Secret regenerate:** `POST /api/static-shares/:id/regenerate-bot-secret` returns a fresh 64-hex string; the stored value is updated; the secret is NOT in the response.
8. **No bot_url → no-op:** a static share without `bot_webhook_url` produces zero fetches on trigger, and `sendDiscordWebhookOnce` still fires (legacy path unchanged).

## Reference: the consumer's expected contract (already implemented in 10-man-discord-bot)
- File: `src/streambot/webhookServer.js`
- Endpoints: `POST /webhook/stream`, `GET /health`, `GET /webhook/help`
- Auth: `x-webhook-secret` HMAC header (see above)
- Accepts: structured `{share_slug, stream_url?, title?, guild_id?, channel_id?}` OR fallback `{username, content, embeds}`
- Status codes: 200 ok / 400 no source / 401 bad auth / 405 wrong method / 413 oversize / 502 not streamable / 503 disabled / 500 internal

## Notes for the agent
- `iptv-share` uses Node ESM (`"type": "module"`), Node 20+, `pnpm`. Check `package.json` before adding anything.
- Do not break the existing `discord_webhook_url` path — it is live in production.
- Do not add new dependencies.
- If you add a new admin page field, mirror the existing `AdminSharePage.jsx` style (same CSS variables, same input classes).
- Keep the change small and surgical. This is a feature addition, not a refactor.
