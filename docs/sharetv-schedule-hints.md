# ShareTV schedule suggestions

`getShareTvScheduleHint(source, config)` reads the existing public
`GET /api/public/share/:slug` endpoint on `SHARETV_BASE`. It returns
`{ detected, startAt, title? }`, where `startAt` is an ISO UTC timestamp or
`null`. The earliest future `programs[]`/`events[]` entry supplies the time:
programme rows use `start_at`/`end_at`, static events use `starts_at`/`ends_at`.
Locked, expired, past and channel-only shares offer no time suggestion.

The lookup has a 1500ms budget and does not resolve streams, start playback,
send integration keys, or change the ShareTV preview endpoint contract. No
ShareTV server changes are needed. Accepting a suggestion only fills the
scheduler form; submitting the form creates the schedule.
