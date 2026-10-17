'use strict';
const crypto = require('node:crypto');
const sharp = require('sharp');
const { MAX_ARTWORK_BYTES, artworkScope, artworkUrl } = require('../presenceArtwork');

async function fetchPresenceArtwork(url, signal, { preserveAspect = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const response = await fetch(parsed, { signal: controller.signal, redirect: preserveAspect ? 'error' : 'follow' });
    if (!response.ok || !/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > 3 * 1024 * 1024) return null;
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) return null;
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    const jpeg = await sharp(Buffer.concat(chunks), { limitInputPixels: 4096 * 4096 })
      .rotate().resize(preserveAspect ? 640 : 512, preserveAspect ? 640 : 512,
        preserveAspect ? { fit: 'inside', withoutEnlargement: true } : { fit: 'contain', background: '#000000' })
      .timeout({ seconds: 3 }).jpeg({ quality: 80 }).toBuffer();
    controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    return jpeg.length <= MAX_ARTWORK_BYTES ? jpeg : null;
  } catch { return null; }
  finally { clearTimeout(timeout); controller.abort(); signal?.removeEventListener('abort', abort); }
}

class PresenceArtwork {
  constructor(manager, publish, { fetchImage = fetchPresenceArtwork, now = Date.now, isAvailable = () => true, onScopeChange = () => {} } = {}) {
    Object.assign(this, { manager, publish, fetchImage, now, isAvailable, onScopeChange });
    this.scope = null; this.artifact = null; this.flight = null; this.nextAt = 0; this.closed = false;
  }
  sync() {
    if (this.closed) return;
    const status = this.manager.status();
    const config = this.manager.config || {};
    const enabled = this.isAvailable() && /^\d{17,20}$/.test(config.playerPresenceApplicationId || '') &&
      artworkUrl(config, 'a'.repeat(32));
    const scope = enabled ? artworkScope(status) : null;
    if (scope !== this.scope) {
      this.scope = scope; this.artifact = null; this.nextAt = 0;
      this.flight?.controller.abort();
      this.onScopeChange();
    }
    if (!scope || this.artifact || this.flight || this.now() < this.nextAt) return;
    const controller = new AbortController();
    const flight = { controller }; this.flight = flight;
    this.nextAt = this.now() + 60000;
    flight.promise = Promise.resolve().then(() => this.fetchImage(status.current.thumbnail, controller.signal)).then(bytes => {
      if (!bytes || bytes.length > MAX_ARTWORK_BYTES || controller.signal.aborted || this.closed ||
          !this.isAvailable() || this.scope !== scope || artworkScope(this.manager.status()) !== scope) return;
      const artifact = { scope, capability: crypto.randomBytes(16).toString('hex'), jpeg: bytes.toString('base64') };
      if (this.publish(artifact)) { this.artifact = artifact; this.manager.playerPresence?.sync(); }
    }).catch(() => {}).finally(() => {
      if (this.flight === flight) this.flight = null;
      if (!this.closed && this.scope !== scope) this.sync();
    });
  }
  url() {
    return this.isAvailable() && this.artifact && this.artifact.scope === artworkScope(this.manager.status())
      ? artworkUrl(this.manager.config || {}, this.artifact.capability) : null;
  }
  reconnect() { this.artifact = null; this.scope = null; this.sync(); }
  close() { this.closed = true; this.flight?.controller.abort(); this.artifact = null; }
}
module.exports = { PresenceArtwork, fetchPresenceArtwork };
