const { OpenAI } = require('openai');
const fs = require('fs');
const config = require('../config');

async function transcribeAudio(audioPath = config.AUDIO_OUTPUT_PATH) {
  console.log('[Transcribe] Sending audio to Whisper...');
  const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  const transcript = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'text',
  });

  fs.writeFileSync(config.TRANSCRIPT_PATH, transcript);
  console.log(`[Transcribe] Transcript saved to ${config.TRANSCRIPT_PATH}`);
  return transcript;
}

module.exports = { transcribeAudio };
