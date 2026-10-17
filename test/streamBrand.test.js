'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamBrandTitle, brandDashboardHtml } = require('../src/streamBrand');

test('runtime brand defaults, trims, bounds and strips controls', () => {
  assert.equal(streamBrandTitle({}), 'Chomirack');
  assert.equal(streamBrandTitle({ STREAM_BRAND_TITLE: '  \n ' }), 'Chomirack');
  assert.equal(streamBrandTitle({ STREAM_BRAND_TITLE: '  My Stream\u0000\u202e  ' }), 'My Stream');
  assert.equal(streamBrandTitle({ STREAM_BRAND_TITLE: 'a'.repeat(101) }).length, 100);
});
test('admin and public HTML bootstrap escaped runtime branding before React loads', () => {
  for (const publicId of [null, 'worker']) {
    const html = brandDashboardHtml('<head><title>Stream Deck · Chomirack</title></head>', publicId, '\"><script>alert(1)</script>&');
    assert(!html.includes('<script>'));
    assert(html.includes('name="stream-brand-title" content="&quot;&gt;&lt;script&gt;'));
    assert(html.includes('<title>Stream Deck · &quot;&gt;&lt;script&gt;'));
    assert.equal(html.includes('name="stream-public-id"'), Boolean(publicId));
  }
});

test('runtime branding preserves literal replacement tokens', () => {
  const brand = "$& $` $' $$";
  const html = brandDashboardHtml('<head><title>Original</title></head>', null, brand);
  assert.equal(html, '<head><title>Stream Deck · $&amp; $` $&#39; $$</title><meta name="stream-brand-title" content="$&amp; $` $&#39; $$" /></head>');
});
