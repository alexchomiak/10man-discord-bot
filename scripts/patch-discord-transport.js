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
const previousInitPatch = '    initWebRtc() {\n        const { videoSsrc, rtxSsrc } = this.mediaConnection.webRtcParams;\n        if (!this._videoDef.hasSSRC(videoSsrc)) this._videoDef.addSSRC(videoSsrc);\n        this._videoDef.addRtxSSRC(videoSsrc, rtxSsrc);';
const initPatch = '    initWebRtc() {\n        const { audioSsrc, videoSsrc, rtxSsrc } = this.mediaConnection.webRtcParams;\n        if (!this._audioDef.hasSSRC(audioSsrc)) this._audioDef.addSSRC(audioSsrc);\n        if (!this._videoDef.hasSSRC(videoSsrc)) this._videoDef.addSSRC(videoSsrc);\n        this._videoDef.addRtxSSRC(videoSsrc, rtxSsrc);';
const replacements = [
    ['export class WebRtcConnWrapper {', 'import { BitrateCalculator } from "./BitrateCalculator.js";\nexport class WebRtcConnWrapper {'],
    ['    _videoCodec;', '    _videoCodec;\n    _videoPacer;\n    _videoPacingBps;\n    _bitrateCalculator = new BitrateCalculator();'],
    ['    initWebRtc() {', initPatch],
    ['        const { rtpConfig } = this._videoPacketizer;', '        this._videoPacingBps = Math.max(1000000, this._bitrateCalculator.addSample(frame.length) * 1.25);\n        this._videoPacer?.setBitrate(this._videoPacingBps);\n        const { rtpConfig } = this._videoPacketizer;'],
    ['        this._videoPacketizer.addToChain(new PacingHandler(25 * 1000 * 1000, 1));', '        this._videoPacingBps = 10 * 1000 * 1000;\n        this._videoPacer = new PacingHandler(this._videoPacingBps, 2);\n        this._videoPacketizer.addToChain(this._videoPacer);'],
];
// Keep each native generation's advertised SSRCs bounded. Reuse RTP handlers
// across native reconnects unless Discord assigns a different sender SSRC.
const generationReplacements = [
    ['        this._mediaConn = mediaConn;\n        this._audioDef', '        this._mediaConn = mediaConn;\n        this._configureTrackDefinitions();\n    }\n    _configureTrackDefinitions() {\n        this._audioDef'],
    [initPatch, initPatch.replace('        const { audioSsrc', '        this._webRtcConn?.close();\n        this._configureTrackDefinitions();\n        const { audioSsrc')],
    ['        this._setMediaHandler();\n        return this._webRtcConn;', `        const params = this.mediaConnection.webRtcParams;
        if (this._videoCodec && (this._packetizerAudioSsrc !== params.audioSsrc || this._packetizerVideoSsrc !== params.videoSsrc))
            this.setPacketizer(this._videoCodec, {
                preserveAudio: this._packetizerAudioSsrc === params.audioSsrc,
                preserveVideo: this._packetizerVideoSsrc === params.videoSsrc
            });
        else
            this._setMediaHandler();
        return this._webRtcConn;`],
    ['    setPacketizer(videoCodec) {', '    setPacketizer(videoCodec, { preserveAudio = false, preserveVideo = false } = {}) {'],
    ['        const { audioSsrc, videoSsrc } = this.mediaConnection.webRtcParams;\n        const rtpConfigAudio', `        if (!preserveAudio) this._setAudioPacketizer();
        if (!preserveVideo) this._setVideoPacketizer(videoCodec);
        this._setMediaHandler();
    }
    _setAudioPacketizer() {
        const { audioSsrc } = this.mediaConnection.webRtcParams;
        this._packetizerAudioSsrc = audioSsrc;
        const rtpConfigAudio`],
    ['        this._audioPacketizer.addToChain(new RtcpNackResponder());\n        this._videoCodec', `        this._audioPacketizer.addToChain(new RtcpNackResponder());
    }
    _setVideoPacketizer(videoCodec) {
        const { videoSsrc } = this.mediaConnection.webRtcParams;
        this._packetizerVideoSsrc = videoSsrc;
        this._videoCodec`],
    ['        this._videoPacketizer.addToChain(this._videoPacer);\n        this._setMediaHandler();', '        this._videoPacketizer.addToChain(this._videoPacer);\n        // Tracks are attached together by setPacketizer().'],
];
const mediaReplacements = [
    ['    _closed = false;', '    _closed = false;\n    _transportGeneration = 0;'],
    ['                console.error(err);', `                this.emit("transport_event", { type: "websocket-error", generation: this._transportGeneration });
                if (!this.listenerCount("transport_event")) console.error("Discord media websocket error");`],
    ['                const wasStarted = this.status.started;', '                this.emit("transport_event", { type: "websocket-close", code: e.code, generation: this._transportGeneration });\n                const wasStarted = this.status.started;'],
    ['                this.setProtocols().then(() => this.ready(this._webRtcWrapper));', `                this.emit("transport_event", { type: "ready", generation: this._transportGeneration + 1 });
                this.setProtocols().then(() => {
                    this.ready(this._webRtcWrapper);
                });`],
    ['                this.status.started = true;\n            }\n            else if (op === VoiceOpCodes.CLIENTS_CONNECT)', '                this.status.started = true;\n                this.emit("transport_event", { type: "resumed", generation: this._transportGeneration });\n            }\n            else if (op === VoiceOpCodes.CLIENTS_CONNECT)'],
    ['        const reconnect = () => {\n            const webRtcConn = this._webRtcWrapper.initWebRtc();', '        const reconnect = () => {\n            const generation = ++this._transportGeneration;\n            const webRtcConn = this._webRtcWrapper.initWebRtc();'],
    ['            webRtcConn.onStateChange((state) => {\n                if (state === "closed" && !this._closed)', '            webRtcConn.onStateChange((state) => {\n                if (generation !== this._transportGeneration) return;\n                this.emit("transport_event", { type: "native-state", state, generation });\n                if (state === "closed" && !this._closed)'],
    ['        this.emit("select_protocol_ack");', '        this.emit("select_protocol_ack");\n        this.emit("protocol_ready", { generation: this._transportGeneration });'],
    ['        this.sendOpcode(VoiceOpCodes.IDENTIFY, {', '        this.emit("transport_event", { type: "identify", generation: this._transportGeneration });\n        this.sendOpcode(VoiceOpCodes.IDENTIFY, {'],
    ['        this.sendOpcode(VoiceOpCodes.RESUME, {', '        this.emit("transport_event", { type: "resume", generation: this._transportGeneration });\n        this.sendOpcode(VoiceOpCodes.RESUME, {'],
];
function replaceChecked(source, edits) {
    let result = source;
    for (const [oldText, newText] of edits) {
        if (result.includes(newText)) continue;
        const count = result.split(oldText).length - 1;
        if (count !== 1) throw new Error(`Discord transport patch expected one anchor, found ${count}: ${oldText}`);
        result = result.replace(oldText, newText);
    }
    return result;
}
function patchDiscordTransport(root = path.resolve(path.dirname(require.resolve('@dank074/discord-video-stream')), '..')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== '6.0.0') throw new Error(`Transport patch requires discord-video-stream 6.0.0, got ${pkg.version}`);
    const target = path.join(root, 'dist/client/voice/WebRtcWrapper.js');
    const helper = path.join(path.dirname(target), 'BitrateCalculator.js');
    const before = fs.readFileSync(target, 'utf8');
    // Upgrade installs that already received the video-only backport. Native
    // transport routes incoming RTP by the SSRC advertised before addTrack;
    // voice audio needs the same registration as video.
    let after = before.replace(previousInitPatch, initPatch);
    // Upgraded generation patches supersede the original init anchor.
    const freshDefsInit = generationReplacements[1][1];
    if (!after.includes(freshDefsInit)) after = replaceChecked(after, replacements);
    else after = replaceChecked(after, replacements.filter(([old]) => old !== '    initWebRtc() {'));
    after = replaceChecked(after, generationReplacements);
    const mediaTarget = path.join(root, 'dist/client/voice/BaseMediaConnection.js');
    const mediaBefore = fs.readFileSync(mediaTarget, 'utf8');
    const mediaAfter = replaceChecked(mediaBefore, mediaReplacements);
    if (fs.existsSync(helper) && fs.readFileSync(helper, 'utf8') !== calculator)
        throw new Error('Discord bitrate calculator differs from pinned backport');
    fs.writeFileSync(helper, calculator);
    if (after === before && mediaAfter === mediaBefore) return false;
    fs.writeFileSync(target, after);
    fs.writeFileSync(mediaTarget, mediaAfter);
    return true;
}
if (require.main === module) {
    const rtc = require('@lng2004/node-datachannel');
    if (typeof rtc.PacingHandler.prototype.setBitrate !== 'function' || typeof rtc.Video.prototype.addRtxSSRC !== 'function')
        throw new Error('Native transport requires setBitrate and addRtxSSRC');
    console.log(patchDiscordTransport() ? 'patched Discord adaptive pacing and RTX' : 'Discord transport patch already applied');
}
module.exports = { patchDiscordTransport, calculator, replacements, generationReplacements, mediaReplacements };
