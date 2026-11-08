// Gentle, child-friendly sound effects.

interface ToneSpec {
  freq: number;
  to?: number;
  start?: number;
  duration?: number;
  type?: OscillatorType;
  volume?: number;
}

class MemorySounds {
  enabled = true;
  private ctx: AudioContext | null = null;

  private init(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      this.ctx = new AudioCtx();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  private tone({ freq, to, start = 0, duration = 0.18, type = 'sine', volume = 0.09 }: ToneSpec) {
    if (!this.enabled) return;
    const ctx = this.init();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      const when = ctx.currentTime + start;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, when);
      if (to !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), when + duration);
      }
      gain.gain.setValueAtTime(volume, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(when);
      osc.stop(when + duration + 0.02);
    } catch {
      // Audio is a bonus, never a blocker.
    }
  }

  flip() {
    this.tone({ freq: 520, to: 820, duration: 0.09, type: 'triangle', volume: 0.045 });
    this.tone({ freq: 880, to: 640, start: 0.03, duration: 0.07, type: 'sine', volume: 0.03 });
  }

  match() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
      this.tone({ freq, start: index * 0.075, duration: 0.28, type: 'sine', volume: 0.085 });
      this.tone({ freq: freq * 2, start: index * 0.075, duration: 0.18, type: 'triangle', volume: 0.018 });
    });
  }

  mismatch() {
    this.tone({ freq: 330, to: 250, duration: 0.16, type: 'triangle', volume: 0.07 });
    this.tone({ freq: 250, to: 300, start: 0.16, duration: 0.15, type: 'triangle', volume: 0.055 });
  }

  peek() {
    [1046.5, 1318.51, 1567.98, 2093].forEach((freq, index) => {
      this.tone({ freq, start: index * 0.055, duration: 0.22, type: 'sine', volume: 0.045 });
    });
  }

  victory() {
    [523.25, 659.25, 783.99].forEach((freq) => {
      this.tone({ freq, duration: 0.55, type: 'sine', volume: 0.055 });
    });
    const melody = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.51];
    melody.forEach((freq, index) => {
      this.tone({ freq, start: 0.12 + index * 0.11, duration: 0.24, type: 'triangle', volume: 0.065 });
    });
  }
}

export const memorySounds = new MemorySounds();
