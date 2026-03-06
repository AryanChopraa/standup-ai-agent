require('dotenv').config();

const STANDUP_SCRIPT = `
Hey everyone, Aryan here.
Yesterday I finished the auth module and reviewed two PRs.
Today I'm working on the dashboard redesign.
No blockers. Thanks!
`;

module.exports = {
  MEET_URL: process.env.MEET_URL,
  TRIGGER_NAME: process.env.TRIGGER_NAME || 'Aryan',
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_VOICE_ID: process.env.GROQ_VOICE_ID || 'daniel',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TO: process.env.EMAIL_TO,
  EMAIL_APP_PASSWORD: process.env.EMAIL_APP_PASSWORD,
  STANDUP_SCRIPT,
  CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  AUDIO_OUTPUT_PATH: './meeting.wav',
  TRANSCRIPT_PATH: './transcript.txt',
};
