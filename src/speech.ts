const SPEECH = Object.freeze({
  DEFAULT_DRAFT_CHAT_NAME: 'the draft chat',
  DEFAULT_PICK_NAME: 'the pick',
  FIGHT_FALLBACK: 'fight! fight! fight!',
  draftIntro: ({ captainAName, teamNameA, captainBName, teamNameB, draftChatName }) => (
    `Welcome to the Player Draft. ${captainAName} will lead the team ${teamNameA} against ${captainBName} and the ${teamNameB}. Captains, interact with the Discord message in ${draftChatName} to make your choices!`
  ),
  matchupReady: ({ teamNameA, teamNameB, draftChatName }) => (
    `${teamNameA} will match up against ${teamNameB}. May the best team win. To Start the match, click the Start button on the message in ${draftChatName}.`
  ),
  draftPick: ({ captainName, pickedText, nextCaptainName }) => (
    nextCaptainName
      ? `${captainName} drafted ${pickedText}. Next pick, ${nextCaptainName}.`
      : `${captainName} drafted ${pickedText}. Draft picks complete.`
  )
});

function formatSpeechList(items, fallback = SPEECH.DEFAULT_PICK_NAME) {
  const values = items.filter(Boolean);
  if (values.length > 1) {
    return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
  }
  return values[0] || fallback;
}

module.exports = { SPEECH, formatSpeechList };
