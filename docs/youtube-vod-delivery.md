# YouTube VOD delivery investigation (2026-09-25)

The server's freeze excerpt showed the FFmpeg output total stuck at 9,968,962
bytes while outgoing media drained. Outgoing bytes then reached zero for two
one-second samples. A new 2,658,313-byte producer batch restored playback.
FFmpeg remained alive and no recovery/reopening appeared in the excerpt.
This establishes producer starvation; it does not alone distinguish HTTP
starvation from an encoder stall. WebSocket state does not measure UDP loss.

For the exact reported `6mEgeIgY1C4` source, yt-dlp offered a 1080p H.264 file
of 4,230,142,539 bytes and specified `http_chunk_size: 10485760`. Our resolver
retained only the direct URL. FFmpeg 7.1 supports neither that yt-dlp setting
nor the newer native HTTP `request_size` option.

A sequential HTTP comparison read and discarded the same first 32 MiB from
that URL, with the same User-Agent:

- Open-ended Range: 34.58 seconds.
- Four bounded 8 MiB Range requests: 1.26 seconds.

This demonstrates throttling associated with request shape on the tested
route. The existing software pipeline nevertheless remained smooth locally
for two minutes (largest video gap 40 ms, audio 35 ms): that route still had
enough throughput. It does not prove that throttling is the only cause on the
server. The server's freeze remains to be checked after deployment.

## Change

Prefer YouTube's own separate HLS VOD playlists when yt-dlp exposes both
tracks at no lower resolution than the available direct-file renditions.
Retain preferred-audio-language selection, source height cap, VOD duration,
seek offset, progressive playback, and the existing split-track merge.
No proxy, full download, new cache, buffer enlargement, or retries are added.
Non-YouTube sources and live source selection retain their previous behavior.
If suitable HLS tracks are unavailable, the existing direct path remains.

YouTube's HLS audio has extensionless AAC segment URLs. FFmpeg 7.1 rejects
these by default, so `extension_picky=0` is set only for HTTPS playlists on
`manifest.googlevideo.com/api/manifest/hls_playlist/`.

The real FFmpeg/demux/paced-track pipeline played the remote HLS source at
1920x1080/30 for two minutes with maximum gaps of 43 ms video and 29 ms audio.
FFmpeg RSS was around 500–507 MiB; the Node process remained below its 800 MiB
diagnostic stop threshold. This uses a counting transport, not Discord, and
software encoding, not Arc. It is not a long-duration memory-stability test.

## Diagnostics

VERBOSE telemetry now reports FFmpeg frame progress and its age. The previous
event-loop monitor called nonexistent `resume/pause` methods; it now uses
`enable/disable`, so the server should stop reporting `el_* = n/a` for that
reason. The progress listener is removed at stop. No URLs are included.

Reference: yt-dlp's FAQ documents YouTube's throttling of large HTTP requests:
https://github.com/yt-dlp/yt-dlp/wiki/FAQ
FFmpeg's newer native request-size option is documented at:
https://ffmpeg.org/ffmpeg-protocols.html#http

Additional bounded checks: seeking one hour into the long VOD passed with
maximum gaps of 37 ms video / 26 ms audio. The second reported source,
`JjeZ-oaROQM`, also offers segmented H.264 and English audio; a 30-second
pipeline check passed at 1080p30 output with gaps below 37 ms / 26 ms. HLS
audio bitrate metadata is sometimes missing, so equal-ranked audio uses
yt-dlp's later (better-ranked) rendition, preserving language preference.
