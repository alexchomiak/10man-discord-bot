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

export default function PublicAurora({ artwork, playing = false }) {
  const [palette, setPalette] = useState(fallback);
  const [previous, setPrevious] = useState(fallback);
  const currentPalette = useRef(fallback);
  const [hidden, setHidden] = useState(document.hidden);
  const particles = useRef(null);
  const playbackRate = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', changed);
    return () => preference.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const element = particles.current;
    if (!element) return;
    let timer;
    const target = playing && !hidden && !reducedMotion ? 1 : 0;
    const applyRate = rate => {
      playbackRate.current = rate;
      if (!element.getAnimations) {
        // Older browsers still freeze safely; supported browsers retain animation phase.
        element.dataset.motionPaused = String(rate === 0);
        return;
      }
      for (const animation of element.getAnimations({ subtree: true })) {
        // Palette color transitions keep their own six-second timing.
        if (animation.animationName?.startsWith('aurora-light')) animation.updatePlaybackRate(rate);
      }
    };
    const resized = () => applyRate(playbackRate.current);
    window.addEventListener('resize', resized);
    const start = playbackRate.current;
    applyRate(hidden || reducedMotion ? 0 : start);
    if (!hidden && !reducedMotion && start !== target) {
      const duration = target ? 500 : 850;
      const steps = 12;
      let step = 0;
      const tick = () => {
        step++;
        const progress = step / steps;
        const eased = progress * progress * (3 - 2 * progress);
        applyRate(start + (target - start) * eased);
        if (step < steps) timer = setTimeout(tick, duration / steps);
      };
      timer = setTimeout(tick, duration / steps);
    }
    return () => { clearTimeout(timer); window.removeEventListener('resize', resized); };
  }, [playing, hidden, reducedMotion]);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const apply = colors => {
      if (cancelled || window.matchMedia('(prefers-reduced-motion: reduce)').matches || colors.join() === currentPalette.current.join()) return;
      setPrevious(currentPalette.current); currentPalette.current = colors; setPalette(colors);
    };
    if (!artwork) { apply(fallback); return; }
    // Public thumbnails are scoped same-origin routes. Never inspect arbitrary remote art.
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
  const colors = values => ({ '--aurora-a': values[0], '--aurora-b': values[1], '--aurora-c': values[2] });
  return <div className={`public-aurora${hidden ? ' is-paused' : ''}`} aria-hidden="true">
    {previous && <div className="aurora-palette aurora-outgoing" key={`old-${palette.join()}`} style={colors(previous)} onAnimationEnd={event => { if (event.target === event.currentTarget) setPrevious(null); }}><i /><i /><i /></div>}
    <div className="aurora-palette aurora-incoming" key={palette.join()} style={colors(palette)}><i /><i /><i /></div>
    <div ref={particles} className="aurora-particles" style={colors(palette)}>{Array.from({ length: 40 }, (_, index) => <b key={index} className={index < 16 ? index % 2 ? 'light-right' : 'light-left' : index < 32 ? 'light-field' : 'light-top'} style={{ '--n': index, '--row': Math.floor(index / 2), '--column': index % 3, '--top-column': index - 32, '--field-column': (index - 16) % 4, '--field-row': Math.floor((index - 16) / 4), '--mobile-column': (index - 16) % 2, '--mobile-row': Math.floor((index - 16) / 2) }} />)}</div>
  </div>;
}
