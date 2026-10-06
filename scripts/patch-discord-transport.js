'use strict';
// Narrow backport from Discord-RE/Discord-video-stream: adaptive pacing
// (56a5268, f5573adffb68, a31b9dab52a1) and RTX (75d9d47a4063).
// Keep v6's demuxer, codecs, DAVE and encoder pipeline unchanged. Unlike upstream,
// associate RTX before addTrack: v6 negotiates before setPacketizer is called.
const fs = require('node:fs');
const path = require('node:path');
const calculator = `// Backported upstream 250ms rolling bitrate calculator.
export class BitrateCalculator {
    _samples = [];
    _totalBytes = 0;
    addSample(bytes) {
        const now = Date.now();
        this._samples.push({ timestampMs: now, bytes });
        this._totalBytes += bytes;
        let expired = 0;
        while (expired < this._samples.length && this._samples[expired].timestampMs < now - 250) {
            this._totalBytes -= this._samples[expired++].bytes;
        }
        if (expired) this._samples.splice(0, expired);
        return this._totalBytes * 8 * 1000 / 250;
    }
}
`;
const replacements = [
    ['export class WebRtcConnWrapper {', 'import { BitrateCalculator } from "./BitrateCalculator.js";\nexport class WebRtcConnWrapper {'],
    ['    _videoCodec;', '    _videoCodec;\n    _videoPacer;\n    _videoPacingBps;\n    _bitrateCalculator = new BitrateCalculator();'],
    ['    initWebRtc() {', '    initWebRtc() {\n        const { videoSsrc, rtxSsrc } = this.mediaConnection.webRtcParams;\n        if (!this._videoDef.hasSSRC(videoSsrc)) this._videoDef.addSSRC(videoSsrc);\n        this._videoDef.addRtxSSRC(videoSsrc, rtxSsrc);'],
    ['        const { rtpConfig } = this._videoPacketizer;', '        this._videoPacingBps = Math.max(1000000, this._bitrateCalculator.addSample(frame.length) * 1.25);\n        this._videoPacer?.setBitrate(this._videoPacingBps);\n        const { rtpConfig } = this._videoPacketizer;'],
    ['        this._videoPacketizer.addToChain(new PacingHandler(25 * 1000 * 1000, 1));', '        this._videoPacingBps = 10 * 1000 * 1000;\n        this._videoPacer = new PacingHandler(this._videoPacingBps, 2);\n        this._videoPacketizer.addToChain(this._videoPacer);'],
];
function patchDiscordTransport(root = path.resolve(path.dirname(require.resolve('@dank074/discord-video-stream')), '..')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== '6.0.0') throw new Error(`Transport patch requires discord-video-stream 6.0.0, got ${pkg.version}`);
    const target = path.join(root, 'dist/client/voice/WebRtcWrapper.js');
    const helper = path.join(path.dirname(target), 'BitrateCalculator.js');
    const before = fs.readFileSync(target, 'utf8');
    let after = before;
    for (const [oldText, newText] of replacements) {
        if (after.includes(newText)) continue;
        const count = after.split(oldText).length - 1;
        if (count !== 1) throw new Error(`Discord transport patch expected one anchor, found ${count}: ${oldText}`);
        after = after.replace(oldText, newText);
    }
    if (fs.existsSync(helper) && fs.readFileSync(helper, 'utf8') !== calculator)
        throw new Error('Discord bitrate calculator differs from pinned backport');
    fs.writeFileSync(helper, calculator);
    if (after === before) return false;
    fs.writeFileSync(target, after);
    return true;
}
if (require.main === module) {
    const rtc = require('@lng2004/node-datachannel');
    if (typeof rtc.PacingHandler.prototype.setBitrate !== 'function' || typeof rtc.Video.prototype.addRtxSSRC !== 'function')
        throw new Error('Native transport requires setBitrate and addRtxSSRC');
    console.log(patchDiscordTransport() ? 'patched Discord adaptive pacing and RTX' : 'Discord transport patch already applied');
}
module.exports = { patchDiscordTransport, calculator };
