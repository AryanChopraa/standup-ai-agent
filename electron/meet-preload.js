const { ipcRenderer } = require('electron');

// Expose triggers to page context
window.ghostDeliver = () => ipcRenderer.send('ghost-deliver');
window.ghostQuery   = (text) => ipcRenderer.send('ghost-query', text);
window.ghostLeave   = () => ipcRenderer.send('ghost-leave');

// Override getUserMedia to inject avatar canvas stream instead of real camera
const _getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  const stream = await _getUserMedia(constraints);

  if (constraints && constraints.video) {
    // Build a canvas avatar
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');

    function drawAvatar() {
      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, 640, 480);
      grad.addColorStop(0, '#1a1a2e');
      grad.addColorStop(1, '#16213e');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 480);

      // Circle
      ctx.beginPath();
      ctx.arc(320, 210, 110, 0, Math.PI * 2);
      ctx.fillStyle = '#0f3460';
      ctx.fill();
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 4;
      ctx.stroke();

      // Initials
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 90px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AC', 320, 210);

      // Name label
      ctx.font = 'bold 28px -apple-system, sans-serif';
      ctx.fillStyle = '#e0e0e0';
      ctx.fillText('Aryan Chopra', 320, 380);

      // Subtle pulse ring
      const t = Date.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2);
      ctx.beginPath();
      ctx.arc(320, 210, 120 + pulse * 10, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(233, 69, 96, ${0.3 * pulse})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    drawAvatar();
    setInterval(drawAvatar, 1000 / 30);

    const avatarStream = canvas.captureStream(30);
    const avatarTrack = avatarStream.getVideoTracks()[0];

    // Remove real camera tracks, add avatar
    stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
    stream.addTrack(avatarTrack);
  }

  return stream;
};
