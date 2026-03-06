const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const config = require('../config');

async function generateVoice(text, outputPath = './standup.wav') {
  console.log('[TTS] Generating voice clip via Groq...');
  const groq = new Groq({ apiKey: config.GROQ_API_KEY });

  const response = await groq.audio.speech.create({
    model: 'canopylabs/orpheus-v1-english',
    voice: config.GROQ_VOICE_ID,
    input: text,
    response_format: 'wav',
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  console.log(`[TTS] Voice saved to ${outputPath}`);
  return outputPath;
}

// Run standalone: node src/tts.js
if (require.main === module) {
  generateVoice(config.STANDUP_SCRIPT, './standup.wav').catch(console.error);
}

module.exports = { generateVoice };
