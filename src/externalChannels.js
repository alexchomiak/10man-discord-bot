'use strict';

function parseExternalChannels(value) {
  const seen = new Set();
  return String(value || '').split(',').map(entry => entry.trim()).flatMap(entry => {
    const match = /^(\d{17,20}):(\d{17,20})$/.exec(entry);
    if (!match || seen.has(entry)) return [];
    seen.add(entry);
    return [{ guildId: match[1], id: match[2] }];
  });
}

module.exports = { parseExternalChannels };
