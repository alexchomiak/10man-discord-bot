'use strict';

const RETRY_MS = 60000;
const MAX_TIMER_MS = 2147483647;

// Owns only optional EPG metadata. Never resolves or reopens playable media.
class ShareTvNicknameRefresh {
  constructor({ fetchPreview, isCurrent, onProgramme, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { fetchPreview, isCurrent, onProgramme, now, setTimer, clearTimer });
    this.piece = null;
    this.timer = null;
    this.request = null;
    this.running = false;
  }
  sync(piece) {
    if (piece && (!piece.shareTvChannel || piece.sourceKind !== 'sharetv' || piece.isFiller || !this.isCurrent(piece))) piece = null;
    if (this.piece === piece) return;
    this.stop();
    if (!piece) return;
    this.piece = piece;
    this.onAbort = () => { if (this.piece === piece) this.stop(); };
    piece.control?.signal?.addEventListener('abort', this.onAbort, { once: true });
    void this._refresh();
  }
  stop() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.piece?.control?.signal?.removeEventListener('abort', this.onAbort);
    this.piece = null;
    this.request?.abort();
  }
  _active(piece) { return this.piece === piece && !piece.control?.signal?.aborted && this.isCurrent(piece); }
  _schedule(piece, deadline) {
    if (!this._active(piece)) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this._active(piece)) { this.stop(); return; }
      if (this.now() < deadline) this._schedule(piece, deadline);
      else void this._refresh();
    }, Math.min(MAX_TIMER_MS, Math.max(1, deadline - this.now())));
    this.timer?.unref?.();
  }
  async _refresh() {
    if (this.running || !this.piece) return;
    const piece = this.piece;
    if (!this._active(piece)) { this.stop(); return; }
    this.running = true;
    const controller = new AbortController();
    this.request = controller;
    let preview = null;
    try { preview = await this.fetchPreview(piece.sourceInput, controller.signal); }
    catch { /* Metadata is optional. Retry at the fallback interval. */ }
    finally { this.running = false; if (this.request === controller) this.request = null; }
    if (controller.signal.aborted || !this._active(piece)) {
      if (this.piece && this._active(this.piece)) void this._refresh();
      return;
    }
    const programme = preview?.programme;
    const end = Number(programme?.end_at);
    let imageReady;
    if (typeof programme?.title === 'string' && programme.title.trim() &&
        (!(Number.isFinite(end) && end > 0) || end * 1000 > this.now())) {
      try { imageReady = await this.onProgramme(piece, programme.title, programme); } catch { imageReady = false; }
    }
    if (!this._active(piece)) return;
    const deadline = imageReady !== false && Number.isFinite(end) && end > 0 ? end * 1000 + RETRY_MS : NaN;
    this._schedule(piece, Number.isFinite(deadline) && deadline > this.now() ? deadline : this.now() + RETRY_MS);
  }
}
module.exports = { ShareTvNicknameRefresh, RETRY_MS, MAX_TIMER_MS };
