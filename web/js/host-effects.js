// Host-driven lighting: the keyboard renders "music rhythm" and "screen colour"
// effects from data streamed by the computer. Same signal processing as the
// original musicFollowStore / screenStore (Web Audio analyser, 1x1 canvas).

const FRAME_MS = 40;

export function music3Levels(bytes, mCount = 6) {
  const t = bytes.slice(0, 100);
  const min = Math.min(...t.slice(20, 40));
  const e = Array.from(t, (v) => v - min);
  const max = Math.max(...e);
  const step = max / mCount;
  return e
    .map((v) => {
      const r = step > 0 ? Math.round(v / step) : 0;
      return r < 0 ? 0 : r > mCount ? mCount : r;
    })
    .slice(27, 59);
}

export class MusicFollower {
  constructor(keyboard, onLevels = () => {}) {
    this.kb = keyboard;
    this.onLevels = onLevels;
    this.busy = false;
  }

  async start(source = 'display') {
    this.stop();
    this.stream =
      source === 'mic'
        ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (!this.stream.getAudioTracks().length) {
      this.stop();
      throw new Error('No audio track shared. When sharing a tab or screen, tick "Share audio".');
    }
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const an = this.ctx.createAnalyser();
    an.smoothingTimeConstant = 0.4;
    an.fftSize = 2048;
    src.connect(an);
    const bins = new Uint8Array(an.frequencyBinCount);
    this.timer = setInterval(async () => {
      an.getByteFrequencyData(bins);
      const levels = music3Levels(bins);
      this.onLevels(levels);
      if (this.busy) return;
      this.busy = true;
      try {
        await this.kb.sendMusicFrame(levels);
      } catch {
        /* dropped frame */
      } finally {
        this.busy = false;
      }
    }, FRAME_MS);
    this.stream.getTracks().forEach((t) => t.addEventListener('ended', () => this.stop()));
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.ctx?.close().catch(() => {});
    this.ctx = undefined;
  }

  get running() {
    return !!this.timer;
  }
}

export class ScreenFollower {
  constructor(keyboard, onColor = () => {}) {
    this.kb = keyboard;
    this.onColor = onColor;
    this.busy = false;
  }

  async start() {
    this.stop();
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    this.timer = setInterval(async () => {
      g.drawImage(this.video, 0, 0, 1, 1);
      const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
      this.onColor(r, gr, b);
      if (this.busy) return;
      this.busy = true;
      try {
        await this.kb.sendScreenColor(r, gr, b, a);
      } catch {
        /* dropped frame */
      } finally {
        this.busy = false;
      }
    }, FRAME_MS);
    this.stream.getTracks().forEach((t) => t.addEventListener('ended', () => this.stop()));
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
  }

  get running() {
    return !!this.timer;
  }
}
