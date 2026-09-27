'use strict';

// Render only 64 FFT columns, then enlarge them with nearest-neighbor scaling.
// The mirrored copy gives the bars a floor reflection without a second FFT.
function musicVisualizerFilter({ width, height, fps }) {
  const barWidth = Math.max(64, Math.round(width * 0.6 / 64) * 64);
  const barHeight = Math.max(80, Math.round(height * 0.22));
  const x = Math.round((width - barWidth) / 2);
  const y = Math.round(height * 0.4);
  const rate = Math.max(1, Math.round(fps));
  return `[1:a]showfreqs=s=64x${barHeight}:r=${rate}:mode=bar:ascale=sqrt:fscale=log:` +
    'win_size=2048:averaging=3:colors=0x38cfff|0xb178ff,' +
    `scale=${barWidth}:${barHeight}:flags=neighbor,format=rgba,` +
    'colorkey=0x000000:0.08:0.05,split[bars][mirror];' +
    '[mirror]vflip,colorchannelmixer=aa=0.20[reflection];' +
    `[base][bars]overlay=${x}:${y}:shortest=0:repeatlast=1[lit];` +
    `[lit][reflection]overlay=${x}:${y + barHeight}:shortest=0:repeatlast=1[visual];`;
}

module.exports = { musicVisualizerFilter };
