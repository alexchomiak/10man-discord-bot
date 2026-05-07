const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const {
  AudioPlayerStatus,
  generateDependencyReport,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');
const googleTTS = require('google-tts-api');

const FRAME_BYTES = 3840; // 20ms of 48khz signed 16-bit stereo PCM.
const DEFAULT_MUSIC_PATH = '/app/data/lobby.mp3';
const DEFAULT_TTS_LANG = 'en';
const DEFAULT_TTS_HOST = 'https://translate.google.com';
const TTS_REQUEST_TIMEOUT_MS = 10_000;
const VOICE_READY_WAIT_MS = 5_000;
const MAX_REDIRECTS = 5;

class AudioManagerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AudioManagerError';
    this.code = options.code || 'AUDIO_ERROR';
    this.cause = options.cause;
  }
}

function toAudioError(message, code, cause) {
  return new AudioManagerError(message, { code, cause });
}

function isMissingOpusEncoderError(error) {
  const details = [error?.message, error?.stack, error?.cause?.message, error?.cause?.stack].filter(Boolean).join('\n');
  return details.includes("Cannot find module '@discordjs/opus'")
    && details.includes("Cannot find module 'node-opus'")
    && details.includes("Cannot find module 'opusscript'");
}

function summarizeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    causeName: error?.cause?.name,
    causeCode: error?.cause?.code,
    causeMessage: error?.cause?.message
  };
}

function pcmDurationMs(byteLength) {
  return Math.round(byteLength / FRAME_BYTES * 20);
}

function readBytes(queue, size) {
  const output = Buffer.alloc(size);
  let offset = 0;

  while (offset < size && queue.length > 0) {
    const current = queue[0];
    const needed = size - offset;
    const take = Math.min(needed, current.length);
    current.copy(output, offset, 0, take);
    offset += take;

    if (take === current.length) {
      queue.shift();
    } else {
      queue[0] = current.subarray(take);
    }
  }

  return output;
}

function mixPcm(musicFrame, speechFrame) {
  const mixed = Buffer.alloc(FRAME_BYTES);

  for (let i = 0; i < FRAME_BYTES; i += 2) {
    const musicSample = musicFrame.readInt16LE(i) * 0.35;
    const speechSample = speechFrame.readInt16LE(i) * 1.2;
    const value = Math.max(-32768, Math.min(32767, Math.round(musicSample + speechSample)));
    mixed.writeInt16LE(value, i);
  }

  return mixed;
}

class MixerStream extends Readable {
  constructor() {
    super();
    this.musicQueue = [];
    this.speechQueue = [];
    this.speechEnabled = false;
    this.timer = setInterval(() => this.pushFrame(), 20);
  }

  _read() {}

  addMusic(chunk) {
    if (!this.destroyed) {
      this.musicQueue.push(chunk);
    }
  }

  addSpeech(buffer) {
    if (!this.destroyed && buffer.length > 0) {
      this.speechQueue.push(buffer);
    }
  }

  setSpeechEnabled(enabled) {
    this.speechEnabled = enabled;
  }

  queueStats() {
    const musicBytes = this.musicQueue.reduce((total, chunk) => total + chunk.length, 0);
    const speechBytes = this.speechQueue.reduce((total, chunk) => total + chunk.length, 0);
    return {
      musicChunks: this.musicQueue.length,
      musicBytes,
      speechChunks: this.speechQueue.length,
      speechBytes,
      speechQueuedMs: pcmDurationMs(speechBytes),
      speechEnabled: this.speechEnabled
    };
  }

  pushFrame() {
    if (this.destroyed) {
      return;
    }

    const musicFrame = readBytes(this.musicQueue, FRAME_BYTES);
    const speechFrame = this.speechEnabled ? readBytes(this.speechQueue, FRAME_BYTES) : Buffer.alloc(FRAME_BYTES);
    this.push(mixPcm(musicFrame, speechFrame));
  }

  destroy(error) {
    clearInterval(this.timer);
    return super.destroy(error);
  }
}

class AudioManager {
  constructor(config = {}) {
    this.musicPath = config.lobbyMusicPath || DEFAULT_MUSIC_PATH;
    this.debugEnabled = config.audioDebug || process.env.AUDIO_DEBUG === 'true';
    this.voiceSelfDeaf = config.voiceSelfDeaf || process.env.VOICE_SELF_DEAF === 'true';
    this.ttsLang = config.ttsLang || process.env.GOOGLE_TTS_LANG || DEFAULT_TTS_LANG;
    this.ttsSlow = config.ttsSlow ?? process.env.GOOGLE_TTS_SLOW === 'true';
    this.ttsHost = config.ttsHost || process.env.GOOGLE_TTS_HOST || DEFAULT_TTS_HOST;
    this.sessions = new Map();
  }

  log(level, message, details = null) {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    console[level](`[audio] ${message}${suffix}`);
  }

  debug(message, details = null) {
    if (this.debugEnabled) {
      this.log('debug', message, details);
    }
  }

  info(message, details = null) {
    this.log('info', message, details);
  }

  warn(message, details = null) {
    this.log('warn', message, details);
  }

  error(message, details = null) {
    this.log('error', message, details);
  }

  hasMusicFile() {
    return fs.existsSync(this.musicPath);
  }

  async join(channel) {
    const guildId = channel.guild.id;
    this.info('join requested', { guildId, channelId: channel.id, channelName: channel.name });
    const existing = this.sessions.get(guildId);
    if (existing) {
      if (existing.connection.state.status === VoiceConnectionStatus.Destroyed) {
        this.warn('existing voice session was destroyed; creating a new one', { guildId, channelId: existing.channelId });
        this.stop(guildId);
      } else {
        if (existing.channelId !== channel.id) {
          existing.connection.rejoin({ channelId: channel.id, selfDeaf: false });
          existing.channelId = channel.id;
        }

        this.info('reusing existing voice session', {
          guildId,
          channelId: existing.channelId,
          connectionStatus: existing.connection.state.status,
          playerStatus: existing.player.state.status,
          queue: existing.mixer.queueStats()
        });
        this.waitForReadyOrContinue(guildId, existing).catch(() => false);
        return existing;
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: this.voiceSelfDeaf,
      debug: this.debugEnabled
    });

    const mixer = new MixerStream();
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const session = {
      channelId: channel.id,
      connection,
      mixer,
      musicProcess: null,
      player
    };
    session.mixer.setSpeechEnabled(connection.state.status === VoiceConnectionStatus.Ready);

    this.attachSessionHandlers(guildId, session);
    this.sessions.set(guildId, session);
    this.info('created voice session', { guildId, channelId: channel.id, connectionStatus: connection.state.status, selfDeaf: this.voiceSelfDeaf });

    try {
      const resource = createAudioResource(mixer, { inputType: StreamType.Raw });
      player.play(resource);
      const subscription = connection.subscribe(player);
      this.info('audio resource subscribed', {
        guildId,
        channelId: channel.id,
        hasSubscription: Boolean(subscription),
        playerStatus: player.state.status,
        connectionStatus: connection.state.status
      });
    } catch (error) {
      this.stop(guildId);
      this.error('voice audio setup failed', { guildId, channelId: channel.id, error: summarizeError(error) });
      if (isMissingOpusEncoderError(error)) {
        throw toAudioError(
          'Discord voice needs an Opus encoder. Rebuild/redeploy the Docker image so the opusscript dependency is installed, then try again.',
          'MISSING_OPUS_ENCODER',
          error
        );
      }

      throw toAudioError('Discord voice audio setup failed before playback could start.', 'VOICE_AUDIO_SETUP_FAILED', error);
    }

    this.startMusic(session);
    await this.waitForReadyOrContinue(guildId, session);
    return session;
  }

  async waitForReadyOrContinue(guildId, session) {
    if (session.connection.state.status === VoiceConnectionStatus.Ready) {
      return true;
    }

    try {
      await entersState(session.connection, VoiceConnectionStatus.Ready, VOICE_READY_WAIT_MS);
      return true;
    } catch (error) {
      const reason = error?.code || error?.name || 'unknown';
      this.warn(
        `voice connection did not report Ready within ${VOICE_READY_WAIT_MS}ms; keeping session alive`,
        { guildId, reason, connectionStatus: session.connection.state.status, playerStatus: session.player.state.status, queue: session.mixer.queueStats() }
      );
      return false;
    }
  }

  attachSessionHandlers(guildId, session) {
    session.connection.on('debug', (message) => {
      this.debug('voice connection debug', { guildId, message });
    });

    session.connection.on('stateChange', (oldState, newState) => {
      const speechEnabled = newState.status === VoiceConnectionStatus.Ready;
      session.mixer.setSpeechEnabled(speechEnabled);
      this.info('voice connection state changed', {
        guildId,
        from: oldState.status,
        to: newState.status,
        speechEnabled,
        queue: session.mixer.queueStats()
      });
    });

    session.connection.on('error', (error) => {
      this.error('voice connection error', { guildId, error: summarizeError(error) });
    });

    session.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(session.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(session.connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch (error) {
        this.warn('voice connection disconnected and did not reconnect; cleaning up session', { guildId, error: summarizeError(error) });
        this.stop(guildId);
      }
    });

    session.player.on('stateChange', (oldState, newState) => {
      this.info('audio player state changed', { guildId, from: oldState.status, to: newState.status });
    });

    session.player.on('error', (error) => {
      this.error('audio player error', { guildId, error: summarizeError(error) });
    });

    session.mixer.on('error', (error) => {
      this.error('audio mixer error', { guildId, error: summarizeError(error) });
    });
  }

  startMusic(session) {
    if (!this.hasMusicFile()) {
      this.info('lobby music file missing; music disabled', { musicPath: this.musicPath });
      return;
    }

    if (!ffmpegPath) {
      this.warn('ffmpeg binary missing; lobby music disabled', { musicPath: this.musicPath });
      return;
    }

    const proc = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-stream_loop', '-1',
      '-i', this.musicPath,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ]);

    this.info('starting lobby music ffmpeg', { musicPath: this.musicPath });
    proc.stdout.on('data', (chunk) => session.mixer.addMusic(chunk));
    proc.stderr.on('data', (chunk) => {
      this.warn('lobby music ffmpeg stderr', { message: chunk.toString().trim() });
    });
    proc.on('error', (error) => {
      this.error('lobby music ffmpeg failed to start', { error: summarizeError(error) });
      if (session.musicProcess === proc) {
        session.musicProcess = null;
      }
    });
    proc.on('close', (code, signal) => {
      this.info('lobby music ffmpeg closed', { code, signal });
      if (session.musicProcess === proc) {
        session.musicProcess = null;
      }
    });
    session.musicProcess = proc;
  }

  async speak(guildId, text) {
    const session = this.sessions.get(guildId);
    if (!session) {
      this.warn('TTS requested without an active voice session', { guildId, textLength: text.length });
      return false;
    }

    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.info('TTS request received', {
      guildId,
      requestId,
      textLength: text.length,
      textPreview: text.slice(0, 60),
      connectionStatus: session.connection.state.status,
      playerStatus: session.player.state.status,
      queueBefore: session.mixer.queueStats()
    });

    try {
      const pcm = await this.createSpeechPcm(text, requestId);
      session.mixer.addSpeech(pcm);
      const connectionReady = session.connection.state.status === VoiceConnectionStatus.Ready;
      const queueAfter = session.mixer.queueStats();
      this.info('TTS PCM queued', {
        guildId,
        requestId,
        pcmBytes: pcm.length,
        pcmDurationMs: pcmDurationMs(pcm.length),
        queueAfter,
        connectionStatus: session.connection.state.status,
        playerStatus: session.player.state.status,
        audibleNow: connectionReady
      });
      if (!connectionReady) {
        this.warn('TTS is queued but voice connection is not Ready, so speech is being held instead of drained silently', {
          guildId,
          requestId,
          connectionStatus: session.connection.state.status,
          playerStatus: session.player.state.status,
          queue: queueAfter
        });
      }
      return true;
    } catch (error) {
      this.error('TTS failed', { guildId, requestId, error: summarizeError(error) });
      return false;
    }
  }

  async announcePick(guild, captainName, pickedName, nextCaptainName) {
    const message = nextCaptainName
      ? `${captainName} drafted ${pickedName}. Next pick, ${nextCaptainName}.`
      : `${captainName} drafted ${pickedName}. Draft picks complete.`;
    await this.speak(guild.id, message).catch(() => false);
  }

  async createSpeechPcm(text, requestId = 'manual') {
    const safeText = text.slice(0, 200);
    this.info('TTS generating Google audio URL', {
      requestId,
      safeTextLength: safeText.length,
      truncated: text.length > safeText.length,
      lang: this.ttsLang,
      slow: this.ttsSlow,
      host: this.ttsHost
    });
    const url = googleTTS.getAudioUrl(safeText, { lang: this.ttsLang, slow: this.ttsSlow, host: this.ttsHost });
    const mp3Start = Date.now();
    const mp3Buffer = await this.fetchBuffer(url, 0, requestId);
    this.info('TTS MP3 downloaded', { requestId, mp3Bytes: mp3Buffer.length, elapsedMs: Date.now() - mp3Start });
    const decodeStart = Date.now();
    const pcmBuffer = await this.decodeMp3ToPcm(mp3Buffer, requestId);
    this.info('TTS MP3 decoded to PCM', { requestId, pcmBytes: pcmBuffer.length, pcmDurationMs: pcmDurationMs(pcmBuffer.length), elapsedMs: Date.now() - decodeStart });
    return pcmBuffer;
  }

  fetchBuffer(url, redirectCount = 0, requestId = 'manual') {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'http:' ? http : https;
      this.debug('TTS HTTP request starting', { requestId, host: parsedUrl.host, path: parsedUrl.pathname, redirectCount });
      const request = client.get(parsedUrl, (response) => {
        this.info('TTS HTTP response', { requestId, statusCode: response.statusCode, contentType: response.headers['content-type'], contentLength: response.headers['content-length'] || null, redirectCount });
        const redirectLocation = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && redirectLocation) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(toAudioError('TTS request had too many redirects.', 'TTS_REDIRECT_LIMIT'));
            return;
          }

          const nextUrl = new URL(redirectLocation, parsedUrl).toString();
          this.info('TTS HTTP redirect', { requestId, fromHost: parsedUrl.host, toHost: new URL(nextUrl).host, redirectCount: redirectCount + 1 });
          this.fetchBuffer(nextUrl, redirectCount + 1, requestId).then(resolve, reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(toAudioError(`TTS request failed with status ${response.statusCode}.`, 'TTS_HTTP_ERROR'));
          response.resume();
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', (error) => reject(toAudioError('TTS response stream failed.', 'TTS_STREAM_ERROR', error)));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          this.debug('TTS HTTP response complete', { requestId, bytes: buffer.length, chunks: chunks.length });
          resolve(buffer);
        });
      });

      request.setTimeout(TTS_REQUEST_TIMEOUT_MS, () => {
        request.destroy(toAudioError('TTS request timed out.', 'TTS_TIMEOUT'));
      });
      request.on('error', (error) => reject(error));
    });
  }

  decodeMp3ToPcm(mp3Buffer, requestId = 'manual') {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) {
        reject(new Error('ffmpeg-static did not provide an ffmpeg binary'));
        return;
      }

      this.info('TTS ffmpeg decode starting', { requestId, mp3Bytes: mp3Buffer.length, ffmpegPath });
      const proc = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
      ]);

      const chunks = [];
      const errors = [];
      proc.stdout.on('data', (chunk) => chunks.push(chunk));
      proc.stderr.on('data', (chunk) => errors.push(chunk.toString()));
      proc.on('error', (error) => reject(toAudioError('ffmpeg failed to start for TTS.', 'TTS_FFMPEG_START_ERROR', error)));
      proc.on('close', (code) => {
        if (code === 0) {
          const buffer = Buffer.concat(chunks);
          this.debug('TTS ffmpeg decode complete', { requestId, pcmBytes: buffer.length, chunks: chunks.length });
          resolve(buffer);
        } else {
          reject(toAudioError(`ffmpeg exited with code ${code}: ${errors.join('').trim()}`, 'TTS_FFMPEG_EXIT'));
        }
      });
      proc.stdin.on('error', (error) => reject(toAudioError('Failed to write TTS audio into ffmpeg.', 'TTS_FFMPEG_STDIN_ERROR', error)));
      proc.stdin.end(mp3Buffer);
    });
  }

  stop(guildId) {
    this.info('stopping voice session', { guildId });
    const session = this.sessions.get(guildId);
    if (!session) {
      const existing = getVoiceConnection(guildId);
      existing?.destroy();
      return;
    }

    if (session.musicProcess) {
      session.musicProcess.kill('SIGKILL');
    }
    session.player.stop(true);
    session.mixer.destroy();
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
    this.sessions.delete(guildId);
  }

  dependencyReport() {
    return generateDependencyReport();
  }

  status(guildId) {
    const session = this.sessions.get(guildId);
    if (!session) {
      return null;
    }

    return {
      channelId: session.channelId,
      hasMusic: this.hasMusicFile(),
      playerStatus: session.player.state.status || AudioPlayerStatus.Idle,
      connectionStatus: session.connection.state.status,
      queue: session.mixer.queueStats()
    };
  }
}

module.exports = {
  AudioManager,
  AudioManagerError
};
