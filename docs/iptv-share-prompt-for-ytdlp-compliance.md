# Prompt for the other agent: yt-dlp-platform share support in iptv-share

> Hand this to a coding agent with read/write access to the `/Users/alexchomiak/code/iptv-share` repo.
> **Design (final, agreed with the consuming bot):** iptv-share does **NOT** run yt-dlp and does **NOT** return a pre-resolved CDN URL. It exposes the **original platform page URL** on the public share payload, flagged with `media_kind: "platform"`. The **consuming app owns yt-dlp resolution** — the 10-man-discord-bot selfbot already runs yt-dlp in-process (see `src/streambot/sources.js` → `resolveYtdlp`) and the same is expected of any other yt-dlp-capable consumer.
>
> Scope is narrow and **additive**: for a share whose `channels.stream_url` is a **platform page** (Twitch, YouTube, Vimeo, Facebook, Instagram, TikTok, and any other site the allow-list covers), `GET /api/public/share/:slug` now additionally returns `media_kind` + `media_url` (original page URL). Everything else — the existing `stream_url`, `hls_url`, the `/api/public/stream` proxy, the web player — is byte-for-byte unchanged.

## Why

Today a channel imported with a platform-page `stream_url` is broken for every non-browser consumer:

- `twitch.tv/foo` is not a media stream — the bot (and the web player, in this case) cannot play it.
- The bot's own yt-dlp fallback cannot kick in, because the bot only sees the **proxied** URL iptv-share hands back (`/api/public/stream/:slug?u=<base64>&sig=<sig>`), not the original platform URL.

The clean split of responsibilities is:
- **iptv-share** = the source-of-truth for *what the stream is* (it knows `channels.stream_url`). It should tell the consumer "this share is a platform page, here is the page URL."
- **Consumer** = the one with the ffmpeg + yt-dlp process. It resolves the page URL to a direct media URL and plays it.

This keeps the security-sensitive bits (SSRF, process spawn) on the consumer side, which is the machine that will also spawn ffmpeg anyway, and keeps iptv-share a thin proxy + directory of shares.

## Exact contract to implement on the iptv-share side

### 1. Public share payload — additive `media_kind` + `media_url`
In `GET /api/public/share/:slug` (see `src/server/index.js` around line 2820 for the *static* branch and line 2881-2890 for the *temporary/programs* branch — both need it), **only** when:
- the share is authorized (`!locked`), and
- the share is currently streamable under the existing rules (`shareIsStreamable(share)` for range-mode, `Boolean(activeProgram)` for programs-mode, `Boolean(activeEvent)` for static-event), and
- the **effective source URL** (`activeEvent?.stream_url` for static, `activeProgram?.stream_url || share.stream_url` for programs/range) is a **platform page** (see §2),

add to the payload:

```js
payload.media_kind = "platform";
payload.media_url  = <the effective source URL, verbatim>;
```

Do **NOT** set these fields when the source is an ordinary HLS/TP/MP4/native URL, even if a consumer *could* play it — the point of the field is to signal "you need yt-dlp, ffmpeg alone won't."

Do **NOT** change the existing `stream_url` / `hls_url` / `stream_kind` fields. Web players read those and keep working.

### 2. "Platform page" classification (iptv-share side)
A new module `src/server/platforms.js` exporting:

```js
export const PLATFORM_HOSTS = [
  'twitch.tv', 'youtube.com', 'youtu.be',
  'vimeo.com', 'facebook.com', 'fb.watch',
  'instagram.com', 'tiktok.com',
  // extend as needed; see below for the default
];

export function isPlatformPageUrl(url) {
  // absolute http/https
  // hostname (or a subdomain of it) in PLATFORM_HOSTS
  // reject private/link-local/metadata IPs after resolution
  // return boolean
}

export function platformHostAllowedHosts() {
  // returns process.env.PLATFORM_PAGE_HOSTS split on ',', or the default list
}
```

- **Default-allow, env-extendable:** the default list above is the allow-list; `PLATFORM_PAGE_HOSTS=host1,host2` overrides it. An empty env value → empty list → nothing is `media_kind: "platform"`.
- **Subdomain matching:** `host == allowed` OR `host.endsWith('.' + allowed)`.
- **Private-IP reject (defense in depth):** after DNS resolution, reject `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0`, `[::1]`, `[fc00::]/7`, `[fe80::]/10`. This matters because a consumer will now trust `media_url` blindly and spawn yt-dlp against it — we don't want `media_url = "http://169.254.169.254/"` to be a thing.
- **Do not** resolve DNS synchronously in the request path; do it lazily when a consumer asks (or not at all, and let the consumer's own resolver surface the error). The classification above is *syntactic* (hostname only); the IP check is a guard for the admin-side "add a platform page" flow, not a per-request gate.

### 3. Admin creation flow
When an admin creates a static share and enters a `stream_url` that is a platform page:
- The UI should show a discreet hint ("This is a platform share — it will only be playable for yt-dlp-capable consumers. Web players will see the share page but not a stream player.") — no blocking, no validation beyond the existing `http(s)` check.
- No new DB column is needed. `channels.stream_url` already holds the platform URL; this feature just *surfaces it* via the new payload fields.

### 4. Do NOT
- Do NOT spawn `yt-dlp` anywhere in iptv-share. The binary is not in the iptv-share image and should not be.
- Do NOT do per-request DNS lookups, TTL caches, or `force` refresh endpoints on the resolve path — the consumer owns that.
- Do NOT change `/api/public/stream` proxying. It stays m3u8/TS/MP4-only. A platform-page share is simply *not proxied*; the consumer plays the platform URL directly.
- Do NOT add `yt-dlp` as an npm package to iptv-share, and do NOT add it to iptv-share's Dockerfile.
- Do NOT log the full `media_url` at INFO when it contains query strings or tokens (it may carry CDN signatures); log the hostname only.

## Consumer contract (already implemented, for reference)

Repo: `10-man-discord-bot`. Relevant code:
- `src/streambot/sources.js:85` — the resolver prefers in this order: `share.media_url || share.hls_url || share.stream_url`.
- `src/streambot/sources.js:176-206` — `resolveYtdlp(raw)`: runs `yt-dlp -g --no-playlist --format bv*+ba/b --socket-timeout 15 <url>` with a 20s hard timeout; on success, returns the last non-empty stdout line (handling the comma `video,audio` case); on failure, returns a human-readable `note`.
- `Dockerfile` installs `yt-dlp` as a standalone binary from the yt-dlp releases tarball (pinned tag; override with `YTDLP_PATH`).

So when a consumer sees `media_kind: "platform"` + `media_url: "https://twitch.tv/foo"`, it will:
1. Call yt-dlp against `https://twitch.tv/foo`,
2. Get a direct mp4/hls URL,
3. Feed it to ffmpeg,
4. Start the Discord video stream.

The consumer will **not** pass `media_url` to its own in-app web player (no such concept in a selfbot); it will **not** pass the proxied `stream_url` to yt-dlp; and it will **not** re-fetch the share to get `media_url` a second time unless the original request returned a 502 and it wants to retry.

### Acceptance (consumer side)
- `resolveSource('https://twitch.tv/foo', …)` → `resolveYtdlp` path → yt-dlp spawns → 200 with a direct URL.
- `resolveSource('https://cdn.example/live/master.m3u8', …)` → `resolveDirect` path → no yt-dlp spawned.
- `resolveSource(<share_slug>, …)` with iptv-share returning `media_kind: "platform"` → `media_url` is used, yt-dlp spawns.
- `resolveSource(<share_slug>, …)` with iptv-share returning `media_kind: "hls"` (or no `media_kind`) → `hls_url` is used, no yt-dlp spawned.

## Config knobs to add to `iptv-share/src/server/config.js`
```js
platformPageHosts: (process.env.PLATFORM_PAGE_HOSTS
  ? process.env.PLATFORM_PAGE_HOSTS
  : 'twitch.tv,tmuxapp.com,youtube.com,youtu.be,vimeo.com,facebook.com,fb.watch,instagram.com,tiktok.com'
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
```

## Tests the agent must add (in `iptv-share/test/`)
1. `isPlatformPageUrl('https://twitch.tv/foo')` → `true` (with the default allow-list).
2. `isPlatformPageUrl('https://m.twitch.tv/foo')` → `true` (subdomain).
3. `isPlatformPageUrl('https://cdn.example/master.m3u8')` → `false`.
4. `isPlatformPageUrl('http://169.254.169.254/')` → `false` even with an allow-list entry that would otherwise match (private-IP guard).
5. `GET /api/public/share/:slug` for a platform-page share returns `media_kind: "platform"` and `media_url` == the original `channels.stream_url`.
6. `GET /api/public/share/:slug` for an ordinary HLS share returns **no** `media_kind` and **no** `media_url`; `stream_url` and `hls_url` are unchanged.
7. A locked (password-protected) share never returns `media_url` to an unauthenticated fetch.
8. The `PLATFORM_PAGE_HOSTS` env empty-string override disables all `media_kind: "platform"` responses.
9. `/api/public/stream` for a platform-page share still returns whatever it returned before (the proxy does not try to play it; that's fine — consumers don't use the proxy for platform shares).

## Notes
- Node ESM, Node 20+, `pnpm`. Reuse `shareIsStreamable`, `findActiveStaticEvent`, `findActiveShareProgram` from existing code; do not duplicate.
- `yt-dlp` is a consumer-side dependency. iptv-share has no runtime dependency on it.
- Keep the change surgical and additive. Web players, the `/api/public/stream` proxy, and the existing webhook delivery path must all continue working unchanged.
- If you want to test the full loop locally, pair this with `10-man-discord-bot` and the selfbot's `webhookServer` (`POST /webhook/stream`) — the bot's resolver will exercise `resolveYtdlp` against your `media_url` end-to-end.
