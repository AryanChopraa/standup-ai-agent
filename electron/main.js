require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

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
  ipcMain.removeAllListeners('trigger-fired');
  log('Cancelled.');
  done('cancelled');
}

// Phase 1: open meet window, generate voice, wait for user to join + click Deliver
async function openMeet(config) {
  cancelled = false;
  const { meetUrl, standupScript } = config;

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
        contextIsolation: true,
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

    await meetWindow.loadURL(meetUrl);
    if (cancelled) return;

    log('Waiting for Meet to load...');
    await muteMicPreJoin(meetWindow);
    await turnOffCameraPreJoin(meetWindow);
    await autoJoin(meetWindow);
    if (cancelled) return;

    log('Joined! Watching chat. Click "Deliver Now" or someone can say "you go" in chat.');

    // Open chat panel and inject observer
    await injectChatObserver(meetWindow);

    // Signal UI to show Deliver button
    if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send('meet-open');

    // Start recording now so we capture the whole meeting
    startRecording(AUDIO_PATH);

    // Wait for either UI button or chat trigger
    await new Promise((resolve) => {
      ipcMain.once('deliver-now', resolve);
      ipcMain.once('trigger-fired', resolve);
    });
    if (cancelled) return;

    await deliverStandup();

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
  if (meetWindow && !meetWindow.isDestroyed()) { meetWindow.close(); meetWindow = null; }
  try { stopRecording(); } catch (e) {}

  log('Done!');
  done('success');
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
      const TRIGGERS = ['you go', 'go ahead', 'your turn', 'aryan go', 'u go', 'go aryan', 'aryan ur turn'];

      function checkMessage(text) {
        const t = text.toLowerCase().trim();
        if (!t) return;
        if (TRIGGERS.some(phrase => t.includes(phrase))) {
          console.log('[Ghost] Chat trigger matched:', t);
          window.ghostTrigger();
        }
      }

      function scanNode(node) {
        if (node.nodeType !== 1) return;
        if (node.classList.contains('huGk4e') || node.classList.contains('BQRwGe')) {
          checkMessage(node.innerText || node.textContent || '');
        }
        node.querySelectorAll('.huGk4e, .BQRwGe').forEach(el => {
          checkMessage(el.innerText || el.textContent || '');
        });
      }

      const observer = new MutationObserver((mutations) => {
        mutations.forEach(m => m.addedNodes.forEach(scanNode));
      });

      observer.observe(document.body, { childList: true, subtree: true });
      console.log('[Ghost] Chat observer ready.');
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
