const { OpenAI } = require('openai');
const config = require('../config');

async function summariseMeeting(transcript) {
  console.log('[Summarise] Generating meeting notes via GPT-4o...');
  const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a meeting notes assistant. Given a standup meeting transcript, extract structured notes.
Return JSON with this structure:
{
  "attendees": ["name1", "name2"],
  "updates": [{"person": "name", "yesterday": "...", "today": "...", "blockers": "..."}],
  "decisions": ["..."],
  "action_items": [{"owner": "name", "task": "..."}]
}`,
      },
      {
        role: 'user',
        content: `Here is the meeting transcript:\n\n${transcript}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const notes = JSON.parse(response.choices[0].message.content);
  console.log('[Summarise] Notes generated.');
  return notes;
}

module.exports = { summariseMeeting };
