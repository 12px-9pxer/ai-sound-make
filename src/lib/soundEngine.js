let audioCtx = null;

export async function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  return audioCtx;
}

function createImpulseResponse(ctx, duration = 1.8, decay = 2.6) {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const impulse = ctx.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    let smoothed = 0;
    for (let index = 0; index < length; index += 1) {
      const t = index / length;
      smoothed = smoothed * 0.94 + (Math.random() * 2 - 1) * 0.06;
      data[index] = smoothed * Math.pow(1 - t, decay) * 0.72;
    }
  }

  return impulse;
}

function createSoftNoise(ctx, duration) {
  const sampleRate = ctx.sampleRate;
  const length = Math.ceil(sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  let smoothed = 0;

  for (let index = 0; index < length; index += 1) {
    smoothed = smoothed * 0.985 + (Math.random() * 2 - 1) * 0.015;
    data[index] = smoothed;
  }

  return buffer;
}

function connectOptionalFilter(ctx, source, layer, start, destination) {
  let current = source;

  if (layer.bandpass) {
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(layer.bandpass, start);
    filter.Q.setValueAtTime(layer.q || 1, start);
    current.connect(filter);
    current = filter;
  } else {
    if (layer.highpass) {
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.setValueAtTime(layer.highpass, start);
      current.connect(highpass);
      current = highpass;
    }

    if (layer.lowpass) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.setValueAtTime(layer.lowpass, start);
      lowpass.Q.setValueAtTime(layer.q || 0.55, start);
      current.connect(lowpass);
      current = lowpass;
    }
  }

  current.connect(destination);
}

function semitoneToFrequency(base, semitone) {
  return base * Math.pow(2, semitone / 12);
}

function scheduleTone(ctx, options) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const stopAt = options.start + options.duration;

  osc.type = options.type;
  osc.frequency.setValueAtTime(options.frequency, options.start);
  osc.detune.setValueAtTime(options.detune || 0, options.start);
  panner.pan.setValueAtTime(options.pan || 0, options.start);

  gain.gain.setValueAtTime(0.0001, options.start);
  gain.gain.linearRampToValueAtTime(options.peak, options.start + options.attack);
  gain.gain.setValueAtTime(options.peak, options.start + Math.max(options.attack + 0.02, options.duration * 0.36));
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

  osc.connect(gain).connect(panner).connect(options.destination);
  osc.start(options.start);
  osc.stop(stopAt + 0.04);
}

function scheduleLegacyChime(ctx, preset, start, destination) {
  scheduleTone(ctx, {
    frequency: preset.chime,
    start,
    duration: 0.78,
    attack: 0.055,
    peak: preset.chimeGain,
    type: "sine",
    pan: 0.18,
    destination
  });
}

function scheduleLegacyNoise(ctx, preset, start, destination) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const panner = ctx.createStereoPanner();
  const duration = preset.duration + 0.08;

  source.buffer = createSoftNoise(ctx, duration);
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(Math.min(1300, preset.filter * 1.25), start);
  filter.Q.setValueAtTime(0.65, start);
  panner.pan.setValueAtTime(-0.16, start);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(preset.noiseGain, start + 0.18);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  source.connect(filter).connect(gain).connect(panner).connect(destination);
  source.start(start);
  source.stop(start + duration + 0.02);
}

function synthesizeLegacyPreset(ctx, preset, destination, start) {
  const duration = preset.duration;
  const bus = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const reverb = ctx.createConvolver();

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(preset.filter, start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(420, preset.filter * 0.78), start + duration);
  filter.Q.setValueAtTime(preset.q, start);

  reverb.buffer = createImpulseResponse(ctx, Math.min(2.4, duration + 0.66), 2.7);
  dry.gain.setValueAtTime(0.86, start);
  wet.gain.setValueAtTime(preset.auraGain, start);

  master.gain.setValueAtTime(0.0001, start);
  master.gain.linearRampToValueAtTime(preset.master, start + preset.attack);
  master.gain.setValueAtTime(preset.master, start + preset.sustain);
  master.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  limiter.threshold.setValueAtTime(-18, start);
  limiter.knee.setValueAtTime(18, start);
  limiter.ratio.setValueAtTime(4, start);
  limiter.attack.setValueAtTime(0.008, start);
  limiter.release.setValueAtTime(0.18, start);

  bus.connect(filter);
  filter.connect(dry).connect(master);
  filter.connect(reverb).connect(wet).connect(master);
  master.connect(limiter).connect(destination);

  scheduleTone(ctx, {
    frequency: preset.base,
    start,
    duration,
    attack: preset.attack,
    peak: 0.58,
    type: preset.tone,
    detune: -preset.detune,
    pan: -0.12,
    destination: bus
  });

  scheduleTone(ctx, {
    frequency: preset.upper,
    start: start + preset.topDelay,
    duration: duration - preset.topDelay,
    attack: 0.13,
    peak: 0.44,
    type: "sine",
    detune: preset.detune * 0.4,
    pan: 0.12,
    destination: bus
  });

  scheduleLegacyChime(ctx, preset, start + preset.chimeDelay, bus);
  scheduleLegacyNoise(ctx, preset, start, bus);
}

function schedulePromptTone(ctx, layer, start, destination, frequency, index, count) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const duration = Math.max(0.08, layer.duration - (start - (layer.absoluteStart || start)));
  const stopAt = start + duration;
  const peak = (layer.volume || 0.08) / Math.sqrt(Math.max(1, count));
  const attack = Math.min(layer.attack || 0.08, duration * 0.62);

  osc.type = layer.wave || "sine";
  osc.frequency.setValueAtTime(frequency, start);
  if (layer.endFreqs?.[index]) {
    osc.frequency.exponentialRampToValueAtTime(layer.endFreqs[index], stopAt);
  }

  panner.pan.setValueAtTime(count > 1 ? (index / (count - 1) - 0.5) * 0.42 : 0, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

  osc.connect(gain).connect(panner);
  connectOptionalFilter(ctx, panner, layer, start, destination);
  osc.start(start);
  osc.stop(stopAt + 0.04);
}

function schedulePromptLayer(ctx, layer, presetStart, destination) {
  const start = presetStart + (layer.start || 0);

  if (layer.type === "twoTone") {
    schedulePromptTone(ctx, { ...layer, absoluteStart: start }, start, destination, layer.freqs[0], 0, 2);
    schedulePromptTone(
      ctx,
      { ...layer, absoluteStart: start + (layer.delay || 0.12), duration: Math.max(0.1, layer.duration - (layer.delay || 0.12)) },
      start + (layer.delay || 0.12),
      destination,
      layer.freqs[1],
      1,
      2
    );
    return;
  }

  if (layer.type === "tones" || layer.type === "bell") {
    const freqs = layer.freqs || [];
    freqs.forEach((frequency, index) => {
      schedulePromptTone(ctx, { ...layer, absoluteStart: start }, start + index * (layer.stagger || 0), destination, frequency, index, freqs.length);
    });
    return;
  }

  if (layer.type === "arpeggio") {
    const freqs = layer.freqs || (layer.steps || []).map((step) => semitoneToFrequency(layer.base || 440, step));
    freqs.forEach((frequency, index) => {
      schedulePromptTone(
        ctx,
        { ...layer, attack: 0.018, duration: Math.min(0.62, Math.max(0.16, layer.duration - index * (layer.step || 0.1))), absoluteStart: start },
        start + index * (layer.step || 0.1),
        destination,
        frequency,
        index,
        freqs.length
      );
    });
    return;
  }

  if (layer.type === "noise") {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const duration = layer.duration || 1.8;
    source.buffer = createSoftNoise(ctx, duration + 0.1);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(layer.volume || 0.06, start + Math.min(layer.attack || 0.16, duration * 0.7));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(gain);
    connectOptionalFilter(ctx, gain, layer, start, destination);
    source.start(start);
    source.stop(start + duration + 0.12);
    return;
  }

  if (layer.type === "sweep") {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const duration = layer.duration || 1.8;
    const freqs = layer.freqs || [80, 96];
    const times = layer.times || freqs.map((_, index) => (duration / Math.max(1, freqs.length - 1)) * index);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freqs[0], start);
    for (let index = 1; index < freqs.length; index += 1) {
      osc.frequency.exponentialRampToValueAtTime(freqs[index], start + Math.min(duration, times[index]));
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(layer.volume || 0.1, start + Math.min(layer.attack || 0.2, duration * 0.5));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    connectOptionalFilter(ctx, gain, layer, start, destination);
    osc.start(start);
    osc.stop(start + duration + 0.04);
    return;
  }

  if (layer.type === "fm") {
    const freqs = layer.freqs || [];
    freqs.forEach((frequency, index) => {
      const carrier = ctx.createOscillator();
      const modulator = ctx.createOscillator();
      const modGain = ctx.createGain();
      const amp = ctx.createGain();
      const noteStart = start + index * (layer.stagger || 0);
      const duration = Math.max(0.18, layer.duration - index * (layer.stagger || 0));
      carrier.type = "sine";
      modulator.type = "sine";
      carrier.frequency.setValueAtTime(frequency, noteStart);
      modulator.frequency.setValueAtTime(frequency * (layer.modRatio || 2), noteStart);
      modGain.gain.setValueAtTime(layer.modGain || 12, noteStart);
      amp.gain.setValueAtTime(0.0001, noteStart);
      amp.gain.linearRampToValueAtTime((layer.volume || 0.06) / Math.sqrt(Math.max(1, freqs.length)), noteStart + Math.min(layer.attack || 0.08, duration * 0.6));
      amp.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
      modulator.connect(modGain).connect(carrier.frequency);
      carrier.connect(amp);
      connectOptionalFilter(ctx, amp, layer, noteStart, destination);
      carrier.start(noteStart);
      modulator.start(noteStart);
      carrier.stop(noteStart + duration + 0.04);
      modulator.stop(noteStart + duration + 0.04);
    });
  }
}

function synthesizePromptPreset(ctx, preset, destination, start) {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-16, start);
  limiter.knee.setValueAtTime(18, start);
  limiter.ratio.setValueAtTime(4, start);
  limiter.attack.setValueAtTime(0.006, start);
  limiter.release.setValueAtTime(0.2, start);
  limiter.connect(destination);
  preset.layers.forEach((layer) => schedulePromptLayer(ctx, layer, start, limiter));
}

export function playPreset(preset) {
  if (!audioCtx) {
    return;
  }

  const start = audioCtx.currentTime + 0.03;
  if (preset.layers) {
    synthesizePromptPreset(audioCtx, preset, audioCtx.destination, start);
  } else {
    synthesizeLegacyPreset(audioCtx, preset, audioCtx.destination, start);
  }
}

export async function renderPresetBuffer(preset) {
  const sampleRate = 44100;
  const renderDuration = (preset.duration || 1.5) + 0.85;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(renderDuration * sampleRate), sampleRate);

  if (preset.layers) {
    synthesizePromptPreset(offlineCtx, preset, offlineCtx.destination, 0.05);
  } else {
    synthesizeLegacyPreset(offlineCtx, preset, offlineCtx.destination, 0.05);
  }

  return offlineCtx.startRendering();
}
