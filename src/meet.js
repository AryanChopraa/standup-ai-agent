const puppeteer = require('puppeteer');
const path = require('path');
const { execSync, exec } = require('child_process');
const config = require('../config');

const SPEECH_INJECT_SCRIPT = (triggerName) => `
(function() {
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    console.warn('SpeechRecognition not available');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let lastTriggerTime = 0;
  const DEBOUNCE_MS = 5000;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript.toLowerCase();
      const now = Date.now();
      if (
        transcript.includes('${triggerName.toLowerCase()}') &&
        now - lastTriggerTime > DEBOUNCE_MS
      ) {
        lastTriggerTime = now;
        console.log('[Ghost] Trigger detected: ' + transcript);
        window.__ghostTriggerFired = true;
      }
    }
  };

  recognition.onerror = (e) => console.error('[Ghost] Speech error:', e.error);
  recognition.onend = () => {
    // restart continuously
    try { recognition.start(); } catch(e) {}
  };

  recognition.start();
  console.log('[Ghost] Listening for trigger: ${triggerName}');
})();
`;

async function joinMeet(meetUrl) {
  console.log('[Meet] Connecting to existing Chrome on port 9222...');
  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: 'http://localhost:9222',
      defaultViewport: null,
    });
    console.log('[Meet] Connected to existing Chrome.');
  } catch (e) {
    throw new Error(
      'Could not connect to Chrome. Launch Chrome with remote debugging first:\n' +
      `  "${config.CHROME_PATH}" --remote-debugging-port=9222 --profile-directory=Default\n` +
      'Then re-run this script.'
    );
  }

  console.log('[Meet] Browser launched. Opening new page...');
  const page = await browser.newPage();

  // Grant mic/camera permissions
  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://meet.google.com', [
    'microphone',
    'camera',
    'notifications',
  ]);

  console.log('[Meet] Navigating to Meet URL...');
  await page.goto(meetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[Meet] Page loaded. Waiting for Meet UI...');

  // Wait for join screen to load
  await new Promise(r => setTimeout(r, 5000));

  // Dismiss any "Join with..." modals, click "Join now" or "Ask to join"
  await dismissPreJoinDialogs(page);

  console.log('[Meet] Joined the call. Injecting speech recognition...');
  await page.evaluate(SPEECH_INJECT_SCRIPT(config.TRIGGER_NAME));

  return { browser, page };
}

async function dismissPreJoinDialogs(page) {
  // Try to turn off camera and mic before joining
  try {
    // Turn off mic button (toggle if on)
    await page.evaluate(() => {
      const btns = document.querySelectorAll('[data-is-muted]');
      btns.forEach(btn => {
        if (btn.getAttribute('data-is-muted') === 'false') btn.click();
      });
    });
  } catch (e) {}

  await new Promise(r => setTimeout(r, 1000));

  // Click "Join now" / "Ask to join" button
  const joinSelectors = [
    '[data-idom-class="nCP5yc AjY5Oe DuMIQc LQeN7 jEvJeb QJgqC zEkXQe"]',
    'button[jsname="Qx7uuf"]',
    'button[data-mdc-dialog-action="join"]',
  ];

  for (const sel of joinSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.click(sel);
      console.log('[Meet] Clicked join button.');
      break;
    } catch (e) {
      // try next
    }
  }

  // Fallback: find any button with text "Join now" or "Ask to join"
  try {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const join = buttons.find(b =>
        b.textContent.includes('Join now') || b.textContent.includes('Ask to join')
      );
      if (join) join.click();
    });
  } catch (e) {}

  await new Promise(r => setTimeout(r, 3000));
}

async function waitForTrigger(page, timeoutMs = 30 * 60 * 1000) {
  console.log(`[Meet] Waiting for trigger word "${config.TRIGGER_NAME}"...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const triggered = await page.evaluate(() => window.__ghostTriggerFired);
    if (triggered) {
      await page.evaluate(() => { window.__ghostTriggerFired = false; });
      console.log('[Meet] Trigger fired!');
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('[Meet] Timeout reached — firing fallback trigger.');
  return true;
}

async function playStandupAudio(page, mp3Path) {
  console.log('[Meet] Playing standup audio via BlackHole...');
  // Unmute mic in Meet UI first
  await unmuteMic(page);

  // Play MP3 through system audio (BlackHole routes it to mic input)
  await new Promise((resolve, reject) => {
    exec(`afplay "${path.resolve(mp3Path)}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  console.log('[Meet] Audio playback complete.');
  await new Promise(r => setTimeout(r, 1000));

  // Mute mic again
  await muteMic(page);

  // Send "Thanks!" in chat
  await sendChatMessage(page, 'Thanks! 👻');
}

async function unmuteMic(page) {
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const mute = btns.find(b =>
        b.getAttribute('data-is-muted') === 'true' ||
        b.getAttribute('aria-label')?.toLowerCase().includes('unmute')
      );
      if (mute) mute.click();
    });
    console.log('[Meet] Mic unmuted.');
  } catch (e) {
    console.warn('[Meet] Could not unmute mic:', e.message);
  }
}

async function muteMic(page) {
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const unmute = btns.find(b =>
        b.getAttribute('data-is-muted') === 'false' ||
        b.getAttribute('aria-label')?.toLowerCase().includes('turn off mic') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('mute')
      );
      if (unmute) unmute.click();
    });
    console.log('[Meet] Mic muted.');
  } catch (e) {
    console.warn('[Meet] Could not mute mic:', e.message);
  }
}

async function sendChatMessage(page, message) {
  try {
    // Open chat panel
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const chat = btns.find(b =>
        b.getAttribute('aria-label')?.toLowerCase().includes('chat')
      );
      if (chat) chat.click();
    });

    await new Promise(r => setTimeout(r, 1000));

    // Type and send message
    await page.evaluate((msg) => {
      const input = document.querySelector('[aria-label="Send a message to everyone"]');
      if (input) {
        input.focus();
        // Use execCommand for contenteditable
        document.execCommand('insertText', false, msg);
        // Press Enter
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
    }, message);

    console.log(`[Meet] Sent chat: ${message}`);
  } catch (e) {
    console.warn('[Meet] Could not send chat message:', e.message);
  }
}

async function waitForMeetingEnd(page, checkIntervalMs = 10000) {
  console.log('[Meet] Waiting for meeting to end...');

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const ended = await page.evaluate(() => {
          // Check for "You've left the call" screen
          const body = document.body.innerText;
          return (
            body.includes("You've left the call") ||
            body.includes('Return to home screen') ||
            body.includes('The call has ended')
          );
        });

        if (ended) {
          clearInterval(interval);
          console.log('[Meet] Meeting ended.');
          resolve();
        }
      } catch (e) {
        // Page may have navigated away
        clearInterval(interval);
        resolve();
      }
    }, checkIntervalMs);
  });
}

async function closeBrowser(browser) {
  try {
    await browser.close();
  } catch (e) {}
}

module.exports = {
  joinMeet,
  waitForTrigger,
  playStandupAudio,
  waitForMeetingEnd,
  closeBrowser,
};
