const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const {
  AudioPlayerStatus,
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

  pushFrame() {
    if (this.destroyed) {
      return;
    }

    const musicFrame = readBytes(this.musicQueue, FRAME_BYTES);
    const speechFrame = readBytes(this.speechQueue, FRAME_BYTES);
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
    this.sessions = new Map();
  }

  hasMusicFile() {
    return fs.existsSync(this.musicPath);
  }

  async join(channel) {
    const guildId = channel.guild.id;
    const existing = this.sessions.get(guildId);
    if (existing) {
      if (existing.connection.state.status === VoiceConnectionStatus.Destroyed) {
        this.stop(guildId);
      } else {
        if (existing.channelId !== channel.id) {
          existing.connection.rejoin({ channelId: channel.id, selfDeaf: false });
          existing.channelId = channel.id;
        }

        this.waitForReadyOrContinue(guildId, existing).catch(() => false);
        return existing;
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
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

    this.attachSessionHandlers(guildId, session);
    this.sessions.set(guildId, session);

    try {
      const resource = createAudioResource(mixer, { inputType: StreamType.Raw });
      player.play(resource);
      connection.subscribe(player);
    } catch (error) {
      this.stop(guildId);
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
      console.warn(
        `Voice connection for guild ${guildId} did not report Ready within ${VOICE_READY_WAIT_MS}ms (${reason}); keeping the session alive because Discord may still show the bot in-channel.`
      );
      return false;
    }
  }

  attachSessionHandlers(guildId, session) {
    session.connection.on('error', (error) => {
      console.error(`Voice connection error in guild ${guildId}:`, error);
    });

    session.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(session.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(session.connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch (error) {
        console.warn(`Voice connection disconnected in guild ${guildId}; cleaning up session.`, error);
        this.stop(guildId);
      }
    });

    session.player.on('error', (error) => {
      console.error(`Audio player error in guild ${guildId}:`, error);
    });

    session.mixer.on('error', (error) => {
      console.error(`Audio mixer error in guild ${guildId}:`, error);
    });
  }

  startMusic(session) {
    if (!this.hasMusicFile() || !ffmpegPath) {
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

    proc.stdout.on('data', (chunk) => session.mixer.addMusic(chunk));
    proc.stderr.on('data', (chunk) => {
      console.warn(`Lobby music ffmpeg warning: ${chunk.toString().trim()}`);
    });
    proc.on('error', (error) => {
      console.error('Lobby music ffmpeg failed to start:', error);
      if (session.musicProcess === proc) {
        session.musicProcess = null;
      }
    });
    proc.on('close', () => {
      if (session.musicProcess === proc) {
        session.musicProcess = null;
      }
    });
    session.musicProcess = proc;
  }

  async speak(guildId, text) {
    const session = this.sessions.get(guildId);
    if (!session) {
      return false;
    }

    try {
      const pcm = await this.createSpeechPcm(text);
      session.mixer.addSpeech(pcm);
      return true;
    } catch (error) {
      console.error(`TTS failed in guild ${guildId}:`, error);
      return false;
    }
  }

  async announcePick(guild, captainName, pickedName, nextCaptainName) {
    const message = nextCaptainName
      ? `${captainName} drafted ${pickedName}. Next pick, ${nextCaptainName}.`
      : `${captainName} drafted ${pickedName}. Draft picks complete.`;
    await this.speak(guild.id, message).catch(() => false);
  }

  async createSpeechPcm(text) {
    const safeText = text.slice(0, 200);
    const url = googleTTS.getAudioUrl(safeText, { lang: 'en', slow: false, host: 'https://translate.google.com' });
    const mp3Buffer = await this.fetchBuffer(url);
    return this.decodeMp3ToPcm(mp3Buffer);
  }

  fetchBuffer(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'http:' ? http : https;
      const request = client.get(parsedUrl, (response) => {
        const redirectLocation = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && redirectLocation) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(toAudioError('TTS request had too many redirects.', 'TTS_REDIRECT_LIMIT'));
            return;
          }

          const nextUrl = new URL(redirectLocation, parsedUrl).toString();
          this.fetchBuffer(nextUrl, redirectCount + 1).then(resolve, reject);
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
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });

      request.setTimeout(TTS_REQUEST_TIMEOUT_MS, () => {
        request.destroy(toAudioError('TTS request timed out.', 'TTS_TIMEOUT'));
      });
      request.on('error', (error) => reject(error));
    });
  }

  decodeMp3ToPcm(mp3Buffer) {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) {
        reject(new Error('ffmpeg-static did not provide an ffmpeg binary'));
        return;
      }

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
          resolve(Buffer.concat(chunks));
        } else {
          reject(toAudioError(`ffmpeg exited with code ${code}: ${errors.join('').trim()}`, 'TTS_FFMPEG_EXIT'));
        }
      });
      proc.stdin.on('error', (error) => reject(toAudioError('Failed to write TTS audio into ffmpeg.', 'TTS_FFMPEG_STDIN_ERROR', error)));
      proc.stdin.end(mp3Buffer);
    });
  }

  stop(guildId) {
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

  status(guildId) {
    const session = this.sessions.get(guildId);
    if (!session) {
      return null;
    }

    return {
      channelId: session.channelId,
      hasMusic: this.hasMusicFile(),
      playerStatus: session.player.state.status || AudioPlayerStatus.Idle
    };
  }
}

module.exports = {
  AudioManager,
  AudioManagerError
};
