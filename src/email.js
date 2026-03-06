const nodemailer = require('nodemailer');
const fs = require('fs');
const config = require('../config');

function formatNotes(notes, date) {
  const lines = [];
  lines.push(`Meeting Date: ${date}`);
  lines.push('');

  if (notes.attendees?.length) {
    lines.push(`Attendees: ${notes.attendees.join(', ')}`);
    lines.push('');
  }

  if (notes.updates?.length) {
    lines.push('--- Updates ---');
    for (const u of notes.updates) {
      lines.push(`\n${u.person}:`);
      if (u.yesterday) lines.push(`  Yesterday: ${u.yesterday}`);
      if (u.today) lines.push(`  Today: ${u.today}`);
      if (u.blockers) lines.push(`  Blockers: ${u.blockers}`);
    }
    lines.push('');
  }

  if (notes.decisions?.length) {
    lines.push('--- Decisions ---');
    notes.decisions.forEach((d) => lines.push(`- ${d}`));
    lines.push('');
  }

  if (notes.action_items?.length) {
    lines.push('--- Action Items ---');
    notes.action_items.forEach((a) => lines.push(`- [${a.owner}] ${a.task}`));
    lines.push('');
  }

  return lines.join('\n');
}

async function sendSummaryEmail(notes, transcriptPath = config.TRANSCRIPT_PATH) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.EMAIL_FROM,
      pass: config.EMAIL_APP_PASSWORD,
    },
  });

  const body = formatNotes(notes, date);
  const attachments = [];

  if (fs.existsSync(transcriptPath)) {
    attachments.push({
      filename: 'transcript.txt',
      path: transcriptPath,
    });
  }

  await transporter.sendMail({
    from: config.EMAIL_FROM,
    to: config.EMAIL_TO,
    subject: `StandupGhost - ${date} Meeting Notes`,
    text: body,
    attachments,
  });

  console.log(`[Email] Summary sent to ${config.EMAIL_TO}`);
}

module.exports = { sendSummaryEmail };
