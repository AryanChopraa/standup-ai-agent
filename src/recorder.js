const recorder = require('node-record-lpcm16');
const fs = require('fs');
const config = require('../config');

let recording = null;
let fileStream = null;

function startRecording(outputPath = config.AUDIO_OUTPUT_PATH) {
  console.log('[Recorder] Starting audio capture...');
  fileStream = fs.createWriteStream(outputPath);

  recording = recorder.record({
    sampleRateHertz: 16000,
    threshold: 0,
    recordProgram: 'rec', // sox
    silence: '10.0',
  });

  recording.stream().pipe(fileStream);
  console.log(`[Recorder] Recording to ${outputPath}`);
  return recording;
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!recording) return resolve();
    console.log('[Recorder] Stopping recording...');
    recording.stop();
    fileStream.on('finish', () => {
      console.log('[Recorder] Recording saved.');
      resolve();
    });
    fileStream.end();
  });
}

module.exports = { startRecording, stopRecording };
