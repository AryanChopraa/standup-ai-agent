require('dotenv').config();
const config = require('./config');
const { generateVoice } = require('./src/tts');
const { joinMeet, waitForTrigger, playStandupAudio, waitForMeetingEnd, closeBrowser } = require('./src/meet');
const { startRecording, stopRecording } = require('./src/recorder');
const { transcribeAudio } = require('./src/transcribe');
const { summariseMeeting } = require('./src/summarise');

const MP3_PATH = './standup.wav';

async function main() {
  console.log('\n👻 StandupGhost starting...\n');

  // Validate config
  if (!config.MEET_URL) {
    console.error('ERROR: MEET_URL not set in .env');
    process.exit(1);
  }

  // Phase 1: Pre-generate voice
  // await generateVoice(config.STANDUP_SCRIPT, MP3_PATH);

  // Phase 2: Join Meet
  const { browser, page } = await joinMeet(config.MEET_URL);

  // Phase 3: Start recording
  startRecording(config.AUDIO_OUTPUT_PATH);

  // Phase 4: Wait for trigger word
  await waitForTrigger(page);

  // Phase 5: Deliver standup
  await playStandupAudio(page, MP3_PATH);

  // Phase 6: Wait for meeting to end
  await waitForMeetingEnd(page);

  // Phase 7: Stop recording
  await stopRecording();
  await closeBrowser(browser);

  // Phase 8: Transcribe
  let transcript;
  try {
    transcript = await transcribeAudio(config.AUDIO_OUTPUT_PATH);
  } catch (e) {
    console.error('[Transcribe] Failed:', e.message);
    transcript = '(transcription failed)';
  }

  // Phase 9: Summarise
  let notes;
  try {
    notes = await summariseMeeting(transcript);
  } catch (e) {
    console.error('[Summarise] Failed:', e.message);
    notes = { attendees: [], updates: [], decisions: [], action_items: [] };
  }

  // Phase 10: Print summary
  console.log('\n--- Meeting Notes ---');
  console.log(JSON.stringify(notes, null, 2));
  console.log('---------------------\n');

  console.log('\n👻 StandupGhost done. Go back to sleep.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
