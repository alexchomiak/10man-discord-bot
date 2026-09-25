# Finite VOD producer stall: local reproduction

On 2026-09-25, a 45-second extract from the reported YouTube source
(`6mEgeIgY1C4`) was served over a local HTTP range server as separate H.264
MP4 video and AAC M4A audio. The trace used the real StreamManager FFmpeg
builder, installed demuxer, and PersistentTrackFeeder at 1920x1080/30 and
5 Mbps. A counting transport replaced Discord; FFmpeg 7.1.1 and Node 22.23.2
ran on macOS with software encoding. There was no VPN or remote source.

## Observed A/B results

| Configuration | Largest observed output gaps | FFmpeg RSS |
| --- | --- | --- |
| Previous flags, split source | ~6.4 s on both tracks | ~800 MiB at 5 s; ~1,249 MiB at 10 s, stopped by guard |
| Remove only `apad` | ~6.4 s on both tracks | ~1,246 MiB at 10 s, stopped |
| Pace only video input | ~5.6 s on both tracks | ~1,247 MiB at 15 s, stopped |
| Remove only `-shortest` | video 41 ms, audio 28 ms | ~357–360 MiB during video; infinite padded audio prevented EOF |
| Remove `-shortest` and `apad` (current VOD builder) | video 42 ms, audio 28 ms | ~365–367 MiB while running; natural EOF |

In the failing run, FFmpeg's output progress stayed at approximately 3.5
seconds while native memory grew. The stalling happened with both AAC and
Opus audio. Disabling the startup jitter buffer did not remove it. This
isolates the producer's shortest-stream synchronization as a trigger for
this source and configuration; changing the downstream video/audio wait
cannot fix a producer that stops emitting both tracks.

The same clip as a combined NUT input was smooth even with the old flags.
Thus this demonstrates a split-input failure, not that all long videos or
all Jellyfin failures share one cause. Finite, independently paced inputs
expose the failure; duration alone is not a special branch in the code.
The precise internal FFmpeg queue responsible was not instrumented.

## Repeat without Discord credentials

Use Node 22 and FFmpeg 7.1.x. Supply separate finite video and audio files
shorter than 50 seconds (with ordinary matching timestamps):

```sh
FFMPEG_PATH=/path/to/ffmpeg node scripts/trace-vod-pipeline.cjs video.mp4 audio.m4a
FFMPEG_PATH=/path/to/ffmpeg node scripts/trace-vod-pipeline.cjs video.mp4 audio.m4a --old-shortest
```

The second command restores the old flags for comparison. Run sequentially.
The tool serves only those files on loopback, samples FFmpeg and Node RSS
every five seconds, counts paced output frames, and reports gaps above 150 ms.
It aborts after 60 seconds or a sample above 1,000 MiB FFmpeg / 800 MiB Node
RSS. These sampled checks are **not hard resource limits**; use an OS/container
memory limit for stronger isolation. A healthy short fixture finishes at EOF.
Not every fixture necessarily triggers the old FFmpeg behavior.

The tool deliberately uses zero startup jitter to isolate producer stalls;
production's four-second default is unchanged. It uses software H.264 and a
counting transport, so it does not validate Intel VAAPI, Discord delivery,
source/CDN variability, or long-duration memory stability. Node RSS in the
fixed 45-second run ranged roughly 177–332 MiB; this short run cannot establish
its long-term plateau. No production instance was started.

## Change and scope

Finite VOD now omits both `-shortest` and infinite `apad`. Tracks drain to
natural EOF; unequal track lengths may leave a short tail on the longer
track. Live/filler retain their existing flags. Persistent Go Live ownership,
progressive streaming, pacing/readrate, quality, GPU selection, queue sizes,
and recovery policy are unchanged. Argument regression tests guard finite
combined/split VOD and preservation of the live/filler flags.
