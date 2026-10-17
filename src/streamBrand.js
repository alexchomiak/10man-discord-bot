'use strict';

function streamBrandTitle(env = process.env) {
  return String(env.STREAM_BRAND_TITLE || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100) || 'Chomirack';
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function brandDashboardHtml(html, publicId, brandTitle = streamBrandTitle()) {
  const title = escapeHtml(brandTitle);
  return html.replace(/<title>[^<]*<\/title>/i, () => `<title>Stream Deck · ${title}</title>`)
    .replace('</head>', () => `<meta name="stream-brand-title" content="${title}" />${publicId ? `<meta name="stream-public-id" content="${escapeHtml(publicId)}" />` : ''}</head>`);
}
module.exports = { streamBrandTitle, brandDashboardHtml };
