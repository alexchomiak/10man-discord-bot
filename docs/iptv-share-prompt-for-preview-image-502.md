# ShareTV handoff: preview metadata succeeds, programme image returns 502

Investigate and fix programme artwork delivery for the public share
`https://sharetv.chom.es/s/f9bbbea4-d1f7-444f-acbc-f6ce41b1131f`.

Observed on 2026-10-14 at 03:41 UTC:

- Authenticated Discord preview metadata returned HTTP 200 with channel
  `US: BOOMERANG HD`, current programme ID `142566`, title
  `What&#x27;s New Scooby-Doo?`, `start_at: 1791948600`, and
  `end_at: 1791950400`.
- Metadata included a newly issued signed
  `/api/public/discord-programme-image/:slug/temporary/:id` URL.
- Fetching that fresh image URL without an API key returned HTTP 502 in
  approximately 485ms, `Content-Type: text/plain; charset=UTF-8`, a 16-byte
  `error code: 502` body, and `server: cloudflare`. The request's Cloudflare
  trace ID was `a4a391c22ad19327-ORD`.

The bot received an image URL, but that URL did not deliver an image. These
observations do not establish whether ShareTV's image handler failed or the
edge/reverse proxy failed to reach its origin. The inspected handler normally
ends its explicit 502 responses without a body; the observed Cloudflare body
does not distinguish an edge-generated failure from an intercepted origin
error. A redirect is only a possible cause, not a verified diagnosis.

Read `src/server/discordPreview.js`, especially its public image route. After
validating the signature and share/programme scope, it fetches the stored
`epg_programs.icon` using `redirect: "error"` and a 1500ms timeout. It returns
502 for thrown fetch errors, upstream non-2xx responses, missing response
bodies, or a content type that does not begin with `image/`. Socket/DNS/TLS
errors, an upstream redirect, an upstream denial/missing image, incorrect
content type, or proxy/origin trouble are therefore plausible causes. None
has been proven from the available evidence. Stored icon data and server logs
were not available to this read-only diagnosis.

Please do the following in ShareTV:

1. Reproduce with newly issued preview metadata and its fresh signed image URL;
   obtain the currently active programme because programme `142566` and its
   signature may already have expired. Correlate edge/origin logs with the
   request trace and determine whether the image handler ran.
2. Inspect the relevant stored `epg_programs.icon` and test that upstream from
   the running ShareTV environment. Record sanitized hostname/path, status,
   redirect status/target, content type, elapsed time, and error category.
   Never log API keys, signature values, cookies, or credential query strings.
3. Fix the evidenced failure while preserving bounded image fetches and
   streaming cleanup. If redirects are necessary, validate every target,
   cap redirect count, and retain a total timeout; do not forward credentials
   or integration headers to the artwork host. If source data or reverse
   proxy routing is the problem, repair that instead.
4. Keep the existing preview response shape, integration key scope and
   revocation rules, signed image expiry, share locks/expiry, channel/programme
   membership, and current programme checks. Do not change streaming URLs,
   resolution, or pacing. A usable `icon_url` must return actual image bytes
   with a correct `image/*` content type without an integration key.
5. Add tests for the confirmed failure and upstream success, redirect policy,
   non-image content, non-2xx responses, timeout, and stream/body errors.
   Verify a fresh production preview's image URL returns HTTP 200 and decodes
   as an image, then report the confirmed cause and validation evidence.

Do not paste the integration secret or raw signed image URL into the patch,
logs, or handoff. The Discord bot already falls back when artwork is unusable;
the outstanding failure is delivery of the ShareTV image URL supplied by the
working metadata endpoint.
