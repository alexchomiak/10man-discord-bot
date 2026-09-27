'use strict';

// Render 32 FFT columns, mirror them into 64 centered bars, then enlarge with
// nearest-neighbor scaling. The floor reflection reuses that same FFT.
function musicVisualizerFilter({ width, height, fps }) {
  const barWidth = Math.max(64, Math.round(width * 0.9 / 64) * 64);
  const barHeight = Math.max(80, Math.round(height * 0.16));
  const x = Math.round((width - barWidth) / 2);
  const y = Math.round(height * 0.58);
  const rate = Math.max(1, Math.round(fps));
  const columnWidth = Math.max(1, Math.round(barWidth / 64));
  return `[1:a]volume=8,showfreqs=s=32x${barHeight}:r=${rate}:mode=bar:ascale=cbrt:fscale=log:` +
    'win_size=2048:averaging=2:colors=white[spectrum];' +
    `gradients=s=32x${barHeight}:r=${rate}:nb_colors=2:` +
    `c0=0xbca3d4:c1=0x88bdd3:x0=0:y0=0:x1=0:y1=${barHeight}:speed=0[palette];` +
    '[spectrum][palette]blend=all_mode=multiply:shortest=1,split[left][right];' +
    '[left]hflip[mirrored];[mirrored][right]hstack=inputs=2,' +
    `scale=${barWidth}:${barHeight}:flags=neighbor,drawgrid=w=${columnWidth}:h=${barHeight}:t=2:c=black,format=rgba,` +
    'colorkey=0x000000:0.08:0.05,colorchannelmixer=aa=0.72,split[bars][mirror];' +
    '[mirror]vflip,colorchannelmixer=aa=0.25[reflection];' +
    `[base][bars]overlay=${x}:${y}:shortest=0:repeatlast=1[lit];` +
    `[lit][reflection]overlay=${x}:${y + barHeight}:shortest=0:repeatlast=1[visual];`;
}

module.exports = { musicVisualizerFilter };
