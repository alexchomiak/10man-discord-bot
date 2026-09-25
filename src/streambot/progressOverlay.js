'use strict';

const DEFAULT_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

function formatDuration(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

// This filter is built only for finite VODs with the preference enabled.
// The geq expression touches only an eight-pixel strip, while the video
// retains its original frame size and rate. Its alpha makes the red strip
// grow from the left edge; at the final frame it covers the full width.
function progressOverlayFilter({ baseFilter, durationSec, offsetSec = 0, fontFile = DEFAULT_FONT }) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const duration = Math.round(durationSec * 1000) / 1000;
  const offset = Math.max(0, Math.round((Number.isFinite(offsetSec) ? offsetSec : 0) * 1000) / 1000);
  const elapsed = `T+${offset}`;
  const elapsedText = `%{eif\\:floor((t+${offset})/60)\\:d}\\:%{eif\\:mod(trunc(t+${offset})\\,60)\\:d\\:2}`;
  const text = `${elapsedText} / ${formatDuration(durationSec).replace(':', '\\:')}`;
  return `${baseFilter},split[base][bar];` +
    `[bar]crop=iw:8:0:ih-8,format=gbrap,` +
    `geq=r='255':g='0':b='0':a='if(lt(X,(${elapsed})*W/${duration}),255,0)'[strip];` +
    `[base][strip]overlay=x=0:y=H-h:format=auto,` +
    `drawtext=fontfile=${fontFile}:text='${text}':fontsize=22:fontcolor=white:` +
    `borderw=2:bordercolor=black:x=16:y=h-40`;
}

module.exports = { progressOverlayFilter, formatDuration };
