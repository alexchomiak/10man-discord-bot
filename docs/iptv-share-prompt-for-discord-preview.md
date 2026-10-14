# ShareTV implementation request: Discord programme preview metadata

Implement this in iptv-share; this bot change does not implement or deploy the ShareTV API.

The existing `GET /api/public/share/:slug` includes `programs[].icon_url`,
`server_now`, `active_program_id` for programme shares, and `active_event_id`
for static shares. Programme times use `start_at`/`end_at`; static events use
`starts_at`/`ends_at`. Channel-mode shares expose a channel but no current EPG
programme. Their `share_links.channel_id` links to `epg_programs.channel_id`.

Add `GET /api/integrations/discord/share/:slug/preview`, authenticated with
`X-API-Key`. The bot uses `SHARETV_API_KEY` and calls only its configured
`SHARETV_BASE`, forbids redirects, and abandons metadata after 1500ms. Missing
keys, missing endpoint, failures, and no current programme preserve playback.

Return this small JSON shape (times are Unix seconds):

```json
{
  "preview": {
    "channel_name": "Example channel",
    "programme": {
      "id": 123,
      "title": "Current programme",
      "start_at": 1791890000,
      "end_at": 1791893600,
      "icon_url": "https://images.example/programme.jpg"
    }
  }
}
```

Return `programme: null` when no programme currently airs or it lacks matching
EPG. Select `start_at <= now AND now < end_at` for the share's channel, ordered
by latest `start_at` then ID for deterministic overlaps. Honour the share's
expiry, password lock, channel scope, and existing public visibility rules;
the integration key must not bypass them. Return 404 for unknown/expired
shares and 403 for locked shares. For programme/static shares use their actual
selected channel and active event, normalized to the same shape. Use the
programme's `epg_programs.icon` (or static event icon), never a channel logo as
programme artwork. Return a validated HTTP(S) image URL usable by the bot
without its integration key; either a public upstream URL or a new narrowly
scoped signed image route. Existing `/api/public/program-image/:slug/:id`
checks membership in `share_link_items`, so it cannot serve unrelated current
EPG artwork for channel-only shares without a scoped implementation.

API key issuance and validation do not currently exist and are required:
implement an admin-only key generator with cryptographically random keys,
show each secret once, persist only its hash and metadata, allow revocation,
and validate `X-API-Key` with a constant-time comparison. Scope keys to this
read-only preview endpoint; reject absent/invalid/revoked keys with 401. Never
log key values, return stream URLs/credentials, or grant general admin access.
Add tests for issuance/revocation/authentication, channel-only current EPG,
programme/static normalization, missing images, expiry/lock restrictions,
boundary/overlap selection, and safely accessible image URLs. Keep all stream
resolution, pacing, playback URLs and existing endpoint semantics unchanged.
