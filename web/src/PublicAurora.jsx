import React, { useEffect, useRef, useState } from 'react';

const fallback = ['hsl(215 42% 29%)', 'hsl(193 40% 47%)', 'hsl(79 45% 45%)'];
const palettes = new Map();

// A tiny, bounded sample: no animation loop, and polling the same URL does no work.
function samplePalette(image) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallback;
  context.drawImage(image, 0, 0, 24, 24);
  const pixels = context.getImageData(0, 0, 24, 24).data;
  const buckets = Array.from({ length: 12 }, () => ({ count: 0, hue: 0, saturation: 0, light: 0 }));
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]].map(value => value / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, light = (max + min) / 2;
    if (delta < .08 || light < .08 || light > .9) continue;
    let hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue *= 60;
    const bucket = buckets[Math.floor(hue / 30) % 12];
    bucket.count++; bucket.hue += hue; bucket.saturation += delta / (1 - Math.abs(2 * light - 1)); bucket.light += light;
  }
  const colors = buckets.filter(bucket => bucket.count).sort((a, b) => b.count - a.count).slice(0, 3).map(bucket =>
    `hsl(${Math.round(bucket.hue / bucket.count)} ${Math.round(Math.min(.58, Math.max(.3, bucket.saturation / bucket.count)) * 100)}% ${Math.round(Math.min(.48, Math.max(.28, bucket.light / bucket.count)) * 100)}%)`);
  return fallback.map((color, index) => colors[index] || color);
}

// Numeric colors let the small canvas blend palettes without repainting full-size layers.
function rgb(color) {
  const [h, s, l] = color.match(/[\d.]+/g).map(Number);
  const saturation = s / 100, light = l / 100;
  const a = saturation * Math.min(light, 1 - light);
  return [0, 8, 4].map(n => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  });
}
const initialColors = fallback.map(rgb);
function starSprites(colors) {
  return colors.map(color => {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 24;
    const context = sprite.getContext('2d');
    const light = color.map(value => Math.round(value * .35 + 165)).join(',');
    const glow = context.createRadialGradient(12, 12, 0, 12, 12, 12);
    glow.addColorStop(0, `rgba(${light},.95)`);
    glow.addColorStop(.14, `rgba(${light},.8)`);
    glow.addColorStop(.35, `rgba(${light},.22)`);
    glow.addColorStop(1, `rgba(${light},0)`);
    context.fillStyle = glow; context.fillRect(0, 0, 24, 24);
    return sprite;
  });
}
const smooth = value => value * value * (3 - 2 * value);

export default function PublicAurora({ artwork, playing = false }) {
  const [palette, setPalette] = useState(fallback);
  const [hidden, setHidden] = useState(document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const canvas = useRef(null);
  const stars = useRef(null);
  const starDrift = useRef(null);
  useEffect(() => () => { starDrift.current?.cancel(); starDrift.current = null; }, []);
  const scene = useRef({ phase: 0, speed: 0, colors: initialColors, target: initialColors, from: initialColors, paletteKey: fallback.join(), blendStart: -Infinity });
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionChanged = () => setReducedMotion(preference.matches);
    const visibilityChanged = () => setHidden(document.hidden);
    preference.addEventListener('change', motionChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => { preference.removeEventListener('change', motionChanged); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, []);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d', { alpha: false });
    const starCanvas = stars.current;
    const starContext = starCanvas?.getContext('2d');
    if (!context || !starContext) return;
    const state = scene.current;
    if (!starDrift.current) {
      starDrift.current = starCanvas.animate([
        { transform: 'translate3d(-8px, -20px, 0)' },
        { transform: 'translate3d(8px, 20px, 0)' },
      ], { duration: 5000, iterations: Infinity, direction: 'alternate', easing: 'steps(150, end)' });
      starDrift.current.updatePlaybackRate(0);
    }
    const applyStarRate = rate => {
      if (starDrift.current.playbackRate !== rate) starDrift.current.updatePlaybackRate(rate);
    };
    let timer, stopped = false;
    const now = performance.now();
    if (state.paletteKey !== palette.join()) {
      state.paletteKey = palette.join(); state.from = state.colors;
      state.target = palette.map(rgb); state.blendStart = now;
    }
    const fromSprites = starSprites(state.from), targetSprites = starSprites(state.target);
    let lastAurora = -Infinity, starsDrawn = false;
    const startSpeed = state.speed;
    const targetSpeed = playing && !hidden && !reducedMotion ? 1 : 0;
    const rampDuration = targetSpeed ? 500 : 850;
    let last = now;
    const size = () => {
      const mobile = window.innerWidth <= 740;
      const scale = Math.min((mobile ? 280 : 480) / window.innerWidth, (mobile ? 200 : 300) / window.innerHeight);
      element.width = Math.max(1, Math.round(window.innerWidth * scale));
      element.height = Math.max(1, Math.round(window.innerHeight * scale));
      const starScale = Math.min(window.devicePixelRatio || 1, 1.25, Math.sqrt(1500000 / ((window.innerWidth + 48) * (window.innerHeight + 48))));
      starCanvas.width = Math.max(1, Math.floor((window.innerWidth + 48) * starScale));
      starCanvas.height = Math.max(1, Math.floor((window.innerHeight + 48) * starScale));
      starContext.setTransform(starCanvas.width / (window.innerWidth + 48), 0, 0, starCanvas.height / (window.innerHeight + 48), 0, 0);
      starsDrawn = false;
    };
    size();
    function draw(time) {
      const width = element.width, height = element.height;
      const blend = reducedMotion ? 1 : smooth(Math.min(1, (time - state.blendStart) / 6000));
      state.colors = state.target.map((color, index) => color.map((value, channel) => state.from[index][channel] + (value - state.from[index][channel]) * blend));
      context.fillStyle = '#0b111a'; context.fillRect(0, 0, width, height);
      // Broad, softly edged ribbons cross the room instead of sitting in its corners.
      for (let band = 0; band < 3; band++) {
        const color = state.colors[band].map(Math.round).join(',');
        const center = height * (.08 + band * .28);
        const points = Array.from({ length: 29 }, (_, point) => {
          const x = (point - 2) / 24 * width;
          return [x, center + Math.sin(x / width * 5 + state.phase * .13 + band * 1.8) * height * .12 + Math.sin(x / width * 9 - state.phase * .08) * height * .035];
        });
        // Nested translucent strokes feather each ribbon without any blur/filter pass.
        context.lineCap = context.lineJoin = 'round';
        for (let layer = 0; layer < 10; layer++) {
          context.beginPath();
          points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
          context.lineWidth = height * (.42 - layer * .037);
          context.strokeStyle = `rgba(${color},${.025 + layer * .0015})`;
          context.stroke();
        }
      }
    }
    function drawStars(time) {
      const width = window.innerWidth + 48, height = window.innerHeight + 48;
      const blend = reducedMotion ? 1 : smooth(Math.min(1, (time - state.blendStart) / 6000));
      starContext.clearRect(0, 0, width, height);
      const count = window.innerWidth <= 740 ? 24 : 40;
      for (let index = 0; index < count; index++) {
        const x = (index * .618034 % 1) * width;
        const y = (index * .414213 % 1) * height;
        const diameter = index % 4 ? 10 : 12;
        starContext.globalAlpha = 1 - blend;
        starContext.drawImage(fromSprites[index % 3], x - diameter / 2, y - diameter / 2, diameter, diameter);
        starContext.globalAlpha = blend;
        starContext.drawImage(targetSprites[index % 3], x - diameter / 2, y - diameter / 2, diameter, diameter);
      }
      starContext.globalAlpha = 1;
      starsDrawn = true;
    }
    function tick() {
      if (stopped || document.hidden) return;
      const time = performance.now();
      const ramp = smooth(Math.min(1, (time - now) / rampDuration));
      state.speed = reducedMotion ? 0 : startSpeed + (targetSpeed - startSpeed) * ramp;
      applyStarRate(state.speed);
      state.phase += Math.min(.2, (time - last) / 1000) * state.speed;
      last = time;
      if (time - lastAurora >= 1000 / 12) { draw(time); lastAurora = time; }
      if (!starsDrawn || time - state.blendStart < 6000) drawStars(time);
      // One cached starfield drifts without bitmap repaints once its palette settles.
      if (!reducedMotion && (state.speed > 0 || targetSpeed > 0 || time - state.blendStart < 6000)) timer = setTimeout(tick, 1000 / 12);
    }
    const resized = () => { size(); if (!document.hidden) { draw(performance.now()); drawStars(performance.now()); } };
    window.addEventListener('resize', resized);
    if (hidden) { state.speed = 0; applyStarRate(0); }
    else tick();
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('resize', resized); };
  }, [playing, hidden, reducedMotion, palette]);
  useEffect(() => {
    let cancelled = false;
    const apply = colors => { if (!cancelled && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPalette(current => current.join() === colors.join() ? current : colors); };
    if (!artwork) { apply(fallback); return; }
    let url;
    try { url = new URL(artwork, window.location.href); } catch { apply(fallback); return; }
    if (url.origin !== window.location.origin) { apply(fallback); return; }
    if (palettes.has(url.href)) { apply(palettes.get(url.href)); return; }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const finish = colors => {
      if (cancelled) return;
      palettes.set(url.href, colors);
      if (palettes.size > 8) palettes.delete(palettes.keys().next().value);
      apply(colors);
    };
    image.onload = () => { try { finish(samplePalette(image)); } catch { finish(fallback); } };
    image.onerror = () => finish(fallback);
    image.src = url.href;
    return () => { cancelled = true; image.onload = image.onerror = null; image.removeAttribute('src'); };
  }, [artwork]);
  return <div className="public-aurora" aria-hidden="true"><canvas ref={canvas} className="aurora-ribbons" /><canvas ref={stars} className="aurora-stars" /></div>;
}
