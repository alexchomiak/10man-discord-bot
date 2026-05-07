const fs = require('node:fs');
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
    this.musicQueue.push(chunk);
  }

  addSpeech(buffer) {
    this.speechQueue.push(buffer);
  }

  pushFrame() {
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
    const existing = this.sessions.get(channel.guild.id);
    if (existing) {
      return existing;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const mixer = new MixerStream();
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const resource = createAudioResource(mixer, { inputType: StreamType.Raw });
    player.play(resource);
    connection.subscribe(player);

    const session = {
      channelId: channel.id,
      connection,
      mixer,
      musicProcess: null,
      player
    };

    this.sessions.set(channel.guild.id, session);
    this.startMusic(session);
    return session;
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

    const pcm = await this.createSpeechPcm(text);
    session.mixer.addSpeech(pcm);
    return true;
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

  fetchBuffer(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`TTS request failed with status ${response.statusCode}`));
          response.resume();
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
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
      proc.stdout.on('data', (chunk) => chunks.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
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
    session.connection.destroy();
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
  AudioManager
};
