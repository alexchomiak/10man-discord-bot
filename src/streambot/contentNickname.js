'use strict';

// Count UTF-16 units conservatively while keeping grapheme clusters intact.
function contentNickname(title) {
  const value = typeof title === 'string' ? title.replace(/[\p{Cc}\p{Cf}]/gu, char => char === '\u200d' ? char : ' ').replace(/\s+/gu, ' ').trim() : '';
  if (value.length <= 32) return value;
  let prefix = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    if ((prefix + segment).length > 29) break;
    prefix += segment;
  }
  const boundary = prefix.lastIndexOf(' ');
  if (boundary >= 14) prefix = prefix.slice(0, boundary);
  return prefix.trimEnd() + '...';
}

class ContentNickname {
  constructor(client, report = () => {}) {
    this.client = client;
    this.report = report;
    this.enabled = false;
    this.generation = 0;
    this.attempted = new Map();
    this.pending = Promise.resolve();
  }
  setEnabled(enabled) {
    if (enabled !== this.enabled) {
      this.enabled = enabled;
      this.generation++;
      this.attempted.clear();
      this.wanted = null;
    }
  }
  update(piece) {
    if (!this.enabled || !piece || piece.isFiller ||
        !['sharetv', 'youtube', 'jellyfin'].includes(piece.sourceKind)) return;
    const nickname = contentNickname(piece.shareTvChannel ? piece.contentTitle : piece.contentTitle || piece.title);
    const guildId = piece.guildId;
    if (!guildId || !nickname || this.attempted.get(guildId) === nickname) return;
    this.attempted.set(guildId, nickname);
    this.wanted = { piece, nickname, guildId, generation: this.generation };
    if (this.running) return;
    this.running = true;
    this.pending = Promise.resolve().then(() => this._drain());
  }
  async _drain() {
    while (this.wanted) {
      const wanted = this.wanted;
      this.wanted = null;
      const { piece, nickname, guildId, generation } = wanted;
      const current = () => this.enabled && generation === this.generation &&
        !piece.control?.signal?.aborted && this.attempted.get(guildId) === nickname &&
        (!this.isCurrent || this.isCurrent(piece));
      try {
        if (!current()) continue;
        const guild = this.client.guilds?.cache?.get(guildId) || await this.client.guilds?.fetch(guildId);
        const member = guild?.members?.me || guild?.members?.cache?.get(this.client.user?.id)
          || await guild?.members?.fetch(this.client.user?.id);
        if (!current() || member?.nickname === nickname || typeof member?.setNickname !== 'function') continue;
        await member.setNickname(nickname, 'Derive nickname from content');
      } catch (error) { this.report(error); }
    }
    this.running = false;
  }
}
module.exports = { ContentNickname, contentNickname };
