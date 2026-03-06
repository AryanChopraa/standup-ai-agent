require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// Suppress Chromium internal noise (chunked_data_pipe, srtp, etc.) from stderr
const _write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const s = chunk.toString();
  if (s.includes('chunked_data_pipe') || s.includes('OnSizeReceived') || s.includes('srtp_transport') || s.includes('sdp_offer_answer') || s.includes('ERROR:')) return true;
  return _write(chunk, ...args);
};

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');

const { generateVoice } = require('../src/tts');
const { transcribeAudio } = require('../src/transcribe');
const { summariseMeeting } = require('../src/summarise');
const { startRecording, stopRecording } = require('../src/recorder');

const MP3_PATH   = path.join(__dirname, '../standup.wav');
const AUDIO_PATH = path.join(__dirname, '../meeting.wav');

let uiWindow     = null;
let meetWindow   = null;
let afplayProc   = null;
let cancelled    = false;
let scheduleTimer = null;
let currentStandupScript = '';

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function createUIWindow() {
  uiWindow = new BrowserWindow({
    width: 520,
    height: 660,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'ui-preload.js'),
    },
  });
  uiWindow.loadFile(path.join(__dirname, 'ui/index.html'));
}

function log(msg) {
  console.log(msg);
  if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send('log', msg);
}

function done(status) {
  if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send('run-done', status);
}

function cancel() {
  cancelled = true;
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
  if (afplayProc)    { afplayProc.kill(); afplayProc = null; }
  try { stopRecording(); } catch (e) {}
  if (meetWindow && !meetWindow.isDestroyed()) { meetWindow.close(); meetWindow = null; }
  ipcMain.removeAllListeners('deliver-now');
  ipcMain.removeAllListeners('ghost-deliver');
  ipcMain.removeAllListeners('ghost-query');
  ipcMain.removeAllListeners('ghost-leave');
  log('Cancelled.');
  done('cancelled');
}

// Phase 1: open meet window, generate voice, wait for user to join + click Deliver
async function openMeet(config) {
  cancelled = false;
  const { meetUrl, standupScript } = config;
  currentStandupScript = standupScript;

  try {
    const fs = require('fs');
    if (fs.existsSync(MP3_PATH)) {
      log('Using existing voice clip.');
    } else {
      log('Generating voice clip...');
      await generateVoice(standupScript, MP3_PATH);
    }
    if (cancelled) return;

    log('Opening Google Meet window...');
    meetWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false,
        partition: 'persist:google',
        preload: path.join(__dirname, 'meet-preload.js'),
      },
    });

    meetWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      callback(['media', 'microphone', 'camera', 'notifications'].includes(permission));
    });
    meetWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
      return ['media', 'microphone', 'camera'].includes(permission);
    });
    meetWindow.on('closed', () => { meetWindow = null; });
    meetWindow.webContents.on('console-message', (e, level, msg) => {
      if (msg.startsWith('[Ghost]') && !msg.includes('Node with aryan')) console.log('[Meet]', msg);
    });

    await meetWindow.loadURL(meetUrl);
    if (cancelled) return;

    log('Waiting for Meet to load...');
    await muteMicPreJoin(meetWindow);
    await turnOffCameraPreJoin(meetWindow);
    await autoJoin(meetWindow);
    if (cancelled) return;

    log('Joined! Watching chat + listening for voice. Click "Deliver Now" to go manually.');

    // Open chat panel and inject observer
    await injectChatObserver(meetWindow);

    // Signal UI to show Deliver button
    if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send('meet-open');

    // Start recording now so we capture the whole meeting
    startRecording(AUDIO_PATH);

    // Wait for UI button or chat trigger to deliver standup
    await new Promise((resolve) => {
      ipcMain.once('deliver-now', resolve);
      ipcMain.once('ghost-deliver', resolve);
    });
    if (cancelled) return;

    // Register Q&A and leave handlers BEFORE delivery so no messages are missed
    const queryHandler = async (event, question) => {
      if (!meetWindow || meetWindow.isDestroyed()) return;
      log(`[Q&A] Received query: "${question}"`);
      try {
        log('[Q&A] Generating reply with GPT-4o...');
        const reply = await generateContextualReply(question);
        log(`[Q&A] My answer: "${reply}"`);
        await sendChatMessage(meetWindow, reply);
        log('[Q&A] Converting reply to speech...');
        await autoUnmute(meetWindow);
        const replyAudioPath = path.join(__dirname, '../reply.wav');
        await generateVoice(reply, replyAudioPath);
        log('[Q&A] Speaking reply...');
        await new Promise((resolve, reject) => {
          afplayProc = exec(`afplay "${replyAudioPath}"`, (err) => {
            afplayProc = null;
            if (err && !cancelled) reject(err); else resolve();
          });
        });
        await meetWindow.webContents.executeJavaScript(`
          (function() {
            const btn = Array.from(document.querySelectorAll('button')).find(b =>
              b.getAttribute('aria-label')?.toLowerCase().includes('turn off mic') ||
              b.getAttribute('aria-label')?.toLowerCase().includes('mute mic')
            );
            if (btn) btn.click();
          })();
        `).catch(() => {});
        log('[Q&A] Done.');
      } catch (e) { log('[Q&A] Error: ' + e.message); }
    };
    ipcMain.on('ghost-query', queryHandler);
    const leavePromise = new Promise((resolve) => ipcMain.once('ghost-leave', resolve));

    await deliverStandup();
    log('Staying in call for Q&A. Waiting for "aryan you can leave" in chat...');

    await leavePromise;
    ipcMain.removeListener('ghost-query', queryHandler);
    if (cancelled) return;

    await leaveMeeting();

  } catch (err) {
    if (!cancelled) { log(`Error: ${err.message}`); console.error(err); done('error'); }
  }
}

// Phase 2: play audio, send chat, wait for end, transcribe
async function deliverStandup() {
  if (!meetWindow || meetWindow.isDestroyed()) { log('Meet window closed.'); done('error'); return; }

  log('Delivering standup...');

  // Unmute mic
  await autoUnmute(meetWindow);

  // Play audio
  await new Promise((resolve, reject) => {
    afplayProc = exec(`afplay "${MP3_PATH}"`, (err) => {
      afplayProc = null;
      if (err && !cancelled) reject(err);
      else resolve();
    });
  });
  if (cancelled) return;

  log('Standup delivered!');

  // Mute mic
  await meetWindow.webContents.executeJavaScript(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b =>
        b.getAttribute('aria-label')?.toLowerCase().includes('turn off mic') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('mute mic')
      );
      if (btn) btn.click();
    })();
  `).catch(() => {});

  // Send chat
  await meetWindow.webContents.executeJavaScript(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const chat = btns.find(b => b.getAttribute('aria-label')?.toLowerCase().includes('chat'));
      if (chat) chat.click();
    })();
  `).catch(() => {});

  await sleep(1000);

  await meetWindow.webContents.executeJavaScript(`
    (function() {
      const input = document.querySelector('[aria-label="Send a message to everyone"]');
      if (input) {
        input.focus();
        document.execCommand('insertText', false, 'Thank you everyone, got to go bye! :ghost:');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
    })();
  `).catch(() => {});

  await sleep(2000);
  log('Standup delivered! Staying in call for Q&A...');
}

async function muteMicPreJoin(win) {
  // Try to mute mic on pre-join screen for up to 10s
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (cancelled || !win || win.isDestroyed()) return;
    const muted = await win.webContents.executeJavaScript(`
      (function() {
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = all.find(b => /turn off microphone|turn off mic/i.test(b.getAttribute('aria-label') || ''));
        if (btn) { btn.click(); return true; }
        return false;
      })();
    `).catch(() => false);
    if (muted) { log('Mic muted before joining.'); return; }
    await sleep(500);
  }
}

async function injectChatObserver(win) {
  // Open chat panel
  await win.webContents.executeJavaScript(`
    (function() {
      const all = Array.from(document.querySelectorAll('button, [role="button"]'));
      const chat = all.find(b => /chat/i.test(b.getAttribute('aria-label') || ''));
      if (chat) chat.click();
    })();
  `).catch(() => {});

  await sleep(1500);

  // Inject MutationObserver to watch for trigger phrases in chat
  await win.webContents.executeJavaScript(`
    (function() {
      const DELIVER_TRIGGERS = ["your update", "whats your update", "what's your update", "you go", "go ahead", "your turn", "aryan go", "go aryan", "aryan ur turn", "aryan you go"];
      const LEAVE_TRIGGERS   = ["you can leave", "you can go", "aryan bye", "bye aryan", "you can disconnect"];
      const seen = new Set();
      let delivered = false;
      let lastReplied = 0;

      function checkMessage(text) {
        const key = text.trim().slice(0, 120);
        if (seen.has(key)) return;
        seen.add(key);
        const t = text.toLowerCase().trim();
        if (!t) return;

        // Leave signal
        if (t.includes('aryan') && LEAVE_TRIGGERS.some(p => t.includes(p))) {
          console.log('[Ghost] Leave trigger:', t);
          window.ghostLeave();
          return;
        }

        // Deliver trigger
        if (!delivered && t.includes('aryan') && DELIVER_TRIGGERS.some(p => t.includes(p))) {
          delivered = true;
          console.log('[Ghost] Deliver trigger:', t);
          window.ghostDeliver();
          return;
        }

        // Any message mentioning aryan that isn't a deliver/leave trigger → reply
        const now = Date.now();
        const isKnownTrigger = DELIVER_TRIGGERS.some(p => t.includes(p)) || LEAVE_TRIGGERS.some(p => t.includes(p));
        if (t.includes('aryan') && !isKnownTrigger && now - lastReplied > 8000) {
          lastReplied = now;
          console.log('[Ghost] Query:', t);
          window.ghostQuery(text.trim());
        }
      }

      function scanNode(node) {
        if (node.nodeType !== 1) return;
        // Match message text nodes directly by current Meet class names
        if (node.classList.contains('RLrADb') || node.classList.contains('beTDc')) {
          checkMessage(node.innerText || node.textContent || '');
        }
        node.querySelectorAll('.RLrADb, .beTDc').forEach(el => {
          checkMessage(el.innerText || el.textContent || '');
        });
      }

      const observer = new MutationObserver((mutations) => {
        mutations.forEach(m => m.addedNodes.forEach(scanNode));
      });

      observer.observe(document.body, { childList: true, subtree: true });
      console.log('[Ghost] Chat observer ready (chat-only mode).');
    })();
  `).catch(() => {});
}

async function turnOffCameraPreJoin(win) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (cancelled || !win || win.isDestroyed()) return;
    const clicked = await win.webContents.executeJavaScript(`
      (function() {
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = all.find(b => /turn off camera/i.test(b.getAttribute('aria-label') || ''));
        if (btn) { btn.click(); return true; }
        return false;
      })();
    `).catch(() => false);
    if (clicked) { log('Camera turned off.'); return; }
    await sleep(500);
  }
}

async function autoJoin(win) {
  // Retry clicking "Join now" / "Ask to join" for up to 30s
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (cancelled || !win || win.isDestroyed()) return;
    const clicked = await win.webContents.executeJavaScript(`
      (function() {
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = all.find(b => /join now|ask to join|switch here/i.test(b.textContent));
        if (btn) { btn.click(); return true; }
        return false;
      })();
    `).catch(() => false);
    if (clicked) { log('Clicked join button.'); await sleep(2000); return; }
    await sleep(1000);
  }
  log('Could not find join button — you may need to join manually.');
}

async function autoUnmute(win) {
  // Retry unmuting for up to 10s
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (cancelled || !win || win.isDestroyed()) return;
    const clicked = await win.webContents.executeJavaScript(`
      (function() {
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = all.find(b => /turn on microphone|turn on mic|unmute/i.test(b.getAttribute('aria-label') || ''));
        if (btn) { btn.click(); return true; }
        return false;
      })();
    `).catch(() => false);
    if (clicked) { log('Mic unmuted.'); return; }
    await sleep(500);
  }
  log('Could not auto-unmute — mic may already be on.');
}

function waitForMeetingEnd(win) {
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      if (cancelled) { clearInterval(interval); resolve(); return; }
      try {
        if (!win || win.isDestroyed()) { clearInterval(interval); resolve(); return; }
        const ended = await win.webContents.executeJavaScript(`
          document.body.innerText.includes("You've left the call") ||
          document.body.innerText.includes("Return to home screen") ||
          document.body.innerText.includes("The call has ended")
        `);
        if (ended) { clearInterval(interval); resolve(); }
      } catch (e) { clearInterval(interval); resolve(); }
    }, 10000);
  });
}

async function generateContextualReply(question) {
  const Groq = require('groq-sdk');
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `You are Aryan, a software engineer in a standup meeting. Your standup update was: "${currentStandupScript}". A colleague asked you a follow-up question. Reply naturally in 1-2 sentences. Make up plausible technical details if needed. Be concise.` },
      { role: 'user', content: question },
    ],
    max_tokens: 80,
  });
  return res.choices[0].message.content.trim();
}

async function sendChatMessage(win, message) {
  await win.webContents.executeJavaScript(`
    (function() {
      const input = document.querySelector('[aria-label="Send a message to everyone"]');
      if (input) {
        input.focus();
        document.execCommand('insertText', false, ${JSON.stringify(message)});
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
    })();
  `).catch(() => {});
}

async function leaveMeeting() {
  if (meetWindow && !meetWindow.isDestroyed()) { meetWindow.close(); meetWindow = null; }
  try { stopRecording(); } catch (e) {}
  log('Left the meeting.');
  done('success');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.whenReady().then(() => {
  createUIWindow();

  ipcMain.on('open-meet', (event, config) => {
    cancelled = false;
    if (config.scheduleTime) {
      const [h, m] = config.scheduleTime.split(':').map(Number);
      const now = new Date();
      const target = new Date();
      target.setHours(h, m, 0, 0);
      const delay = target - now;
      if (delay > 0) {
        log(`Scheduled for ${config.scheduleTime} (${Math.round(delay / 60000)} min from now)`);
        scheduleTimer = setTimeout(() => openMeet(config), delay);
        return;
      }
    }
    openMeet(config);
  });

  ipcMain.on('cancel-run', () => cancel());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
