// Procedural audio. Nothing is loaded from disk — every sound is synthesised in
// the browser, so there are no assets to license, nothing to 404 on Vercel, and
// the whole bed can follow the decay arc by moving a few numbers.
//
// An AudioContext cannot start without a user gesture, so start() is called
// from the WAKE UP click.

export type EngineHandle = ReturnType<typeof createAudioEngine>;

type AmbiencePreset = {
  /** Lowpass corner for the room tone: lower reads as heavier, deader air. */
  filterHz: number;
  /** Fundamental of the building's drone. */
  droneHz: number;
  noiseGain: number;
  droneGain: number;
  /** Beat frequency against the drone. Higher is more unsettling. */
  detune: number;
};

// One per loop variation: 09:00, after hours, failing, overgrown.
const AMBIENCE: AmbiencePreset[] = [
  { filterHz: 900, droneHz: 58, noiseGain: 0.05, droneGain: 0.035, detune: 0 },
  { filterHz: 620, droneHz: 52, noiseGain: 0.07, droneGain: 0.05, detune: 4 },
  { filterHz: 420, droneHz: 44, noiseGain: 0.09, droneGain: 0.07, detune: 9 },
  { filterHz: 260, droneHz: 36, noiseGain: 0.12, droneGain: 0.09, detune: 15 },
];

// Step interval in ms by pace. Shorter is a faster gait.
const STEP_INTERVAL = [560, 430, 330, 260];

function makeNoiseBuffer(context: AudioContext, seconds = 2) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // Brown-ish noise: integrated white, which sits lower and reads as "room"
  // rather than "hiss".
  let last = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

export function createAudioEngine() {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;

  let ambientSource: AudioBufferSourceNode | null = null;
  let ambientFilter: BiquadFilterNode | null = null;
  let ambientGain: GainNode | null = null;
  let droneA: OscillatorNode | null = null;
  let droneB: OscillatorNode | null = null;
  let droneGain: GainNode | null = null;

  let stepTimer: number | null = null;
  let stepPhase = 0;
  let started = false;
  let volume = 0.7;
  let muted = false;

  const now = () => context?.currentTime ?? 0;

  const applyMasterGain = () => {
    if (!master || !context) return;
    const target = muted ? 0 : volume;
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setTargetAtTime(target, context.currentTime, 0.08);
  };

  function start() {
    if (started) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    context = new Ctor();
    master = context.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(context.destination);
    noiseBuffer = makeNoiseBuffer(context);

    // Room tone.
    ambientGain = context.createGain();
    ambientGain.gain.value = 0;
    ambientFilter = context.createBiquadFilter();
    ambientFilter.type = "lowpass";
    ambientFilter.frequency.value = 900;
    ambientSource = context.createBufferSource();
    ambientSource.buffer = noiseBuffer;
    ambientSource.loop = true;
    ambientSource.connect(ambientFilter);
    ambientFilter.connect(ambientGain);
    ambientGain.connect(master);
    ambientSource.start();

    // The building's drone: two detuned oscillators so it beats slowly.
    droneGain = context.createGain();
    droneGain.gain.value = 0;
    droneA = context.createOscillator();
    droneB = context.createOscillator();
    droneA.type = "sine";
    droneB.type = "triangle";
    droneA.frequency.value = 58;
    droneB.frequency.value = 58;
    droneA.connect(droneGain);
    droneB.connect(droneGain);
    droneGain.connect(master);
    droneA.start();
    droneB.start();

    started = true;
    setAmbience(0);
  }

  function setAmbience(variationIndex: number) {
    if (!context || !ambientFilter || !ambientGain || !droneGain) return;
    const preset =
      AMBIENCE[Math.max(0, Math.min(AMBIENCE.length - 1, variationIndex))];
    const t = context.currentTime;
    // Slide rather than jump, so a loop reset feels like a dissolve.
    ambientFilter.frequency.setTargetAtTime(preset.filterHz, t, 1.2);
    ambientGain.gain.setTargetAtTime(preset.noiseGain, t, 1.2);
    droneGain.gain.setTargetAtTime(preset.droneGain, t, 1.2);
    droneA?.frequency.setTargetAtTime(preset.droneHz, t, 1.5);
    droneB?.frequency.setTargetAtTime(preset.droneHz + preset.detune / 10, t, 1.5);
    if (droneB) droneB.detune.setTargetAtTime(preset.detune, t, 1.5);
  }

  /** One footstep. Alternates weight so a walk cycle reads as left/right. */
  function footstep(pace = 2) {
    if (!context || !master || !noiseBuffer) return;
    const t = context.currentTime;
    const heavy = stepPhase % 2 === 0;
    stepPhase += 1;

    // Heel: short filtered noise burst.
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.playbackRate.value = 0.8 + Math.random() * 0.4;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = (heavy ? 1500 : 2100) + Math.random() * 400;
    band.Q.value = 0.9;
    const gain = context.createGain();
    const peak = (heavy ? 0.12 : 0.085) * (0.85 + pace * 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    source.connect(band);
    band.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + 0.2);

    // Body: a low thump so it lands with weight.
    const thump = context.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(heavy ? 92 : 78, t);
    thump.frequency.exponentialRampToValueAtTime(46, t + 0.12);
    const thumpGain = context.createGain();
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime(heavy ? 0.1 : 0.07, t + 0.01);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    thump.connect(thumpGain);
    thumpGain.connect(master);
    thump.start(t);
    thump.stop(t + 0.2);
  }

  function setWalking(walking: boolean, pace = 2) {
    if (!started) return;
    const interval = STEP_INTERVAL[Math.max(0, Math.min(3, pace - 1))];
    if (!walking) {
      if (stepTimer !== null) {
        window.clearInterval(stepTimer);
        stepTimer = null;
      }
      return;
    }
    if (stepTimer !== null) window.clearInterval(stepTimer);
    footstep(pace);
    stepTimer = window.setInterval(() => footstep(pace), interval);
  }

  /** Drawer sliding open: a filtered noise sweep with a wooden knock. */
  function playSearch() {
    if (!context || !master || !noiseBuffer) return;
    const t = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.playbackRate.value = 0.6;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(420, t);
    filter.frequency.linearRampToValueAtTime(1500, t + 0.42);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + 0.6);
  }

  /** The key: a small bright metallic chime. */
  function playKey() {
    if (!context || !master) return;
    const t = context.currentTime;
    [2100, 3170, 4480].forEach((frequency, index) => {
      const osc = context!.createOscillator();
      osc.type = "sine";
      osc.frequency.value = frequency * (0.998 + Math.random() * 0.004);
      const gain = context!.createGain();
      const peak = 0.07 / (index + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9 - index * 0.2);
      osc.connect(gain);
      gain.connect(master!);
      osc.start(t);
      osc.stop(t + 1);
    });
  }

  /** The loop resetting: a sucking swell, then silence. */
  function playReset() {
    if (!context || !master || !noiseBuffer) return;
    const t = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.playbackRate.value = 0.5;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1800, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 1.4);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + 1.7);
  }

  /** The door opening onto daylight: a rising wash. */
  function playEscape() {
    if (!context || !master || !noiseBuffer) return;
    const t = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(200, t);
    filter.frequency.linearRampToValueAtTime(3800, t + 5.5);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.26, t + 4.5);
    gain.gain.linearRampToValueAtTime(0.0001, t + 6.5);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + 6.6);
    // Duck the building underneath it.
    ambientGain?.gain.setTargetAtTime(0.01, t, 1.2);
    droneGain?.gain.setTargetAtTime(0.005, t, 1.2);
  }

  function setVolume(next: number) {
    volume = Math.max(0, Math.min(1, next));
    applyMasterGain();
  }

  function setMuted(next: boolean) {
    muted = next;
    applyMasterGain();
    if (muted) setWalking(false);
  }

  function stop() {
    if (stepTimer !== null) {
      window.clearInterval(stepTimer);
      stepTimer = null;
    }
    try {
      ambientSource?.stop();
      droneA?.stop();
      droneB?.stop();
      void context?.close();
    } catch {
      // Already torn down.
    }
    context = null;
    master = null;
    started = false;
  }

  return {
    start,
    stop,
    setAmbience,
    setWalking,
    footstep,
    playSearch,
    playKey,
    playReset,
    playEscape,
    setVolume,
    setMuted,
    get isStarted() {
      return started;
    },
    resume() {
      if (context?.state === "suspended") void context.resume();
    },
    get currentTime() {
      return now();
    },
  };
}
