const COMMANDS = Object.freeze({
  TEAM_DRAFT: {
    name: 'start-draft',
    description: 'Start a random-captain team draft for everyone in your current voice channel.',
    options: Object.freeze({
      PLAYERS: { name: 'players', description: 'Optional even total players to draft; all voice members remain draftable.' },
      CAPTAIN_1: { name: 'captain1', description: 'Optional first captain (must be in the same voice channel).' },
      CAPTAIN_2: { name: 'captain2', description: 'Optional second captain (must be in the same voice channel).' },
      DRAFT_TYPE: { name: 'draft_type', description: 'Draft order type (default: snake).' },
      REFRESH_RATINGS: { name: 'refresh_ratings', description: 'Refresh linked Premier ratings before starting this draft (default false).' }
    })
  },
  TEAM_DRAFT_MOCK: {
    name: 'team-draft-mock',
    description: 'Run a mock draft with fake users so you can test solo.',
    options: Object.freeze({
      PLAYERS: { name: 'players', description: 'Even number of fake players (minimum 4).' },
      SPAWN_VOICE: { name: 'spawn_voice', description: 'After Start Mock Match, create a temporary private mock voice channel and move you there.' },
      BROADCAST: { name: 'broadcast', description: 'Broadcast mock draft results to the channel (default true).' },
      DRAFT_TYPE: { name: 'draft_type', description: 'Draft order type (default: snake).' }
    })
  },
  LINK: {
    name: 'link',
    description: 'Link a player alias to a Steam profile and store their CS Premier rating.',
    options: Object.freeze({
      ALIAS: { name: 'alias', description: 'Alias/display name to use for draft rating labels.' },
      URL: { name: 'url', description: 'Steam profile URL, e.g. steamcommunity.com/id/foo or /profiles/SteamID64.' }
    })
  },
  UNLINK: {
    name: 'unlink',
    description: 'Remove a linked player alias from the local rating database.',
    options: Object.freeze({ ALIAS: { name: 'alias', description: 'Alias to unlink.' } })
  },
  GET_INFO: {
    name: 'get-info',
    description: 'Show the stored Steam/Premier DB record for a linked player alias.',
    options: Object.freeze({ ALIAS: { name: 'alias', description: 'Alias to look up in the player link database.' } })
  },
  REFRESH: {
    name: 'refresh',
    description: 'Refresh Leetify Premier metadata for one linked player alias.',
    options: Object.freeze({ ALIAS: { name: 'alias', description: 'Alias to refresh in the player link database.' } })
  },
  REFRESH_VOICE: { name: 'refresh-voice', description: 'Refresh Leetify Premier metadata for linked players in your voice channel.' },
  LEADERBOARD: { name: 'leaderboard', description: 'Create or update this server’s maintained CS2 ratings leaderboard.' },
  REFRESH_LEADERBOARD: { name: 'refresh-leaderboard', description: 'Refresh this server’s existing maintained CS2 ratings leaderboard now.' },
  DRAFT_STATUS: { name: 'draft-status', description: 'Show current draft/mock status for this server.' },
  DRAFT_CANCEL: { name: 'draft-cancel', description: 'Cancel the active draft in this server and clean temporary resources.' },
  DRAFT_CLEANUP: { name: 'draft-cleanup', description: 'Force cleanup of active draft/mock temporary channels and roles.' },
  RETURN_TO_VOICE: { name: 'return-to-voice', description: 'Move drafted players back to the original voice channel and cleanup draft resources.' },
  BUILD_VERSION: { name: 'build-version', description: 'Show the currently running build commit hash.' },
  TEST_LOBBY_MUSIC: { name: 'test-lobby-music', description: 'Join your voice channel and play lobby music if /app/data/lobby.mp3 exists.' },
  TEST_TTS: {
    name: 'test-tts',
    description: 'Make the bot say a test message in voice.',
    options: Object.freeze({ MESSAGE: { name: 'message', description: 'Message for the bot to say in voice.' } })
  },
  ANNOUNCE: {
    name: 'announce',
    description: 'Set the MP3 announcement played when a user joins voice outside draft mode.',
    options: Object.freeze({
      ALIAS: { name: 'alias', description: 'User whose voice join should trigger this announcement.' },
      FILENAME: { name: 'filename', description: 'MP3 filename in the bot audio directory, e.g. intro.mp3.' }
    })
  },
  RESET_ANNOUNCE_TIMER: {
    name: 'reset-announce-timer',
    description: 'Clear a user announcement cooldown so their next fresh voice join can announce.',
    options: Object.freeze({ ALIAS: { name: 'alias', description: 'User whose announcement cooldown should be reset.' } })
  },
  AUDIO_STATUS: { name: 'audio-status', description: 'Show Discord voice/TTS diagnostics for this server.' }
});

const DRAFT_TYPE_CHOICES = Object.freeze({
  SNAKE: { name: 'Snake', value: 'snake' },
  REGULAR: { name: 'Regular alternating', value: 'regular' }
});

module.exports = { COMMANDS, DRAFT_TYPE_CHOICES };
