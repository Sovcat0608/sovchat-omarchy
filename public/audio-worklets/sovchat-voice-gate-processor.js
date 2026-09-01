const DEFAULT_CONFIG = {
  minOpenRms: 0.012,
  minCloseRms: 0.007,
  openNoiseMultiplier: 2.8,
  closeNoiseMultiplier: 1.7,
  peakOpen: 0.055,
  holdMs: 180,
  attackMs: 8,
  releaseMs: 120,
  closedGain: 0.006,
  noiseFloorRise: 0.03,
  noiseFloorFall: 0.12
};

function coerceNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeConfig(config) {
  const nextConfig = { ...DEFAULT_CONFIG, ...(config || {}) };

  return {
    minOpenRms: coerceNumber(nextConfig.minOpenRms, DEFAULT_CONFIG.minOpenRms),
    minCloseRms: coerceNumber(nextConfig.minCloseRms, DEFAULT_CONFIG.minCloseRms),
    openNoiseMultiplier: coerceNumber(
      nextConfig.openNoiseMultiplier,
      DEFAULT_CONFIG.openNoiseMultiplier
    ),
    closeNoiseMultiplier: coerceNumber(
      nextConfig.closeNoiseMultiplier,
      DEFAULT_CONFIG.closeNoiseMultiplier
    ),
    peakOpen: coerceNumber(nextConfig.peakOpen, DEFAULT_CONFIG.peakOpen),
    holdMs: coerceNumber(nextConfig.holdMs, DEFAULT_CONFIG.holdMs),
    attackMs: Math.max(1, coerceNumber(nextConfig.attackMs, DEFAULT_CONFIG.attackMs)),
    releaseMs: Math.max(1, coerceNumber(nextConfig.releaseMs, DEFAULT_CONFIG.releaseMs)),
    closedGain: coerceNumber(nextConfig.closedGain, DEFAULT_CONFIG.closedGain),
    noiseFloorRise: coerceNumber(nextConfig.noiseFloorRise, DEFAULT_CONFIG.noiseFloorRise),
    noiseFloorFall: coerceNumber(nextConfig.noiseFloorFall, DEFAULT_CONFIG.noiseFloorFall)
  };
}

class SovChatVoiceGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};
    this.profile = processorOptions.profile || "soft";
    this.source = processorOptions.source || "voice-gate";
    this.config = normalizeConfig(processorOptions.config);
    this.currentGain = 1;
    this.gateOpen = true;
    this.noiseFloor = 0.006;
    this.holdSamples = 0;
    this.lastStatsFrame = 0;

    this.port.onmessage = (event) => {
      const payload = event.data || {};
      if (payload.type !== "configure") {
        return;
      }

      this.profile = payload.profile || this.profile;
      this.source = payload.source || this.source;
      this.config = normalizeConfig(payload.config || this.config);
    };
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || [];
    const outputChannels = outputs[0] || [];
    const firstOutput = outputChannels[0];
    const frameCount = firstOutput?.length || inputChannels[0]?.length || 128;

    if (!inputChannels.length || !outputChannels.length) {
      return true;
    }

    const analysisInput = inputChannels[0];
    let sumSquares = 0;
    let peak = 0;

    for (let index = 0; index < frameCount; index += 1) {
      const sample = analysisInput?.[index] ?? 0;
      sumSquares += sample * sample;
      const absSample = Math.abs(sample);
      if (absSample > peak) {
        peak = absSample;
      }
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, frameCount));
    const belowOpenFloor = rms < Math.max(this.config.minOpenRms, this.noiseFloor * 1.35);
    if (!this.gateOpen || belowOpenFloor) {
      const coefficient =
        rms > this.noiseFloor ? this.config.noiseFloorRise : this.config.noiseFloorFall;
      this.noiseFloor += (rms - this.noiseFloor) * coefficient;
      this.noiseFloor = Math.max(0.001, Math.min(this.noiseFloor, this.config.minOpenRms * 0.95));
    }

    const openThreshold = Math.max(
      this.config.minOpenRms,
      this.noiseFloor * this.config.openNoiseMultiplier
    );
    const closeThreshold = Math.max(
      this.config.minCloseRms,
      this.noiseFloor * this.config.closeNoiseMultiplier
    );
    const speechLike = rms >= openThreshold || peak >= this.config.peakOpen;

    if (speechLike) {
      this.gateOpen = true;
      this.holdSamples = Math.round((sampleRate * this.config.holdMs) / 1000);
    } else if (this.gateOpen) {
      this.holdSamples = Math.max(0, this.holdSamples - frameCount);
      if (this.holdSamples === 0 && rms <= closeThreshold) {
        this.gateOpen = false;
      }
    }

    const targetGain = this.gateOpen ? 1 : this.config.closedGain;
    const smoothingMs = targetGain > this.currentGain ? this.config.attackMs : this.config.releaseMs;
    const smoothingCoefficient = 1 - Math.exp(-1 / ((smoothingMs / 1000) * sampleRate));
    const gains = new Float32Array(frameCount);

    for (let index = 0; index < frameCount; index += 1) {
      this.currentGain += (targetGain - this.currentGain) * smoothingCoefficient;
      gains[index] = this.currentGain;
    }

    for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
      const output = outputChannels[channelIndex];
      const input = inputChannels[channelIndex] || inputChannels[0];

      for (let index = 0; index < output.length; index += 1) {
        output[index] = (input?.[index] ?? 0) * (gains[index] ?? this.currentGain);
      }
    }

    if (currentFrame - this.lastStatsFrame > sampleRate * 0.65) {
      this.lastStatsFrame = currentFrame;
      this.port.postMessage({
        type: "stats",
        profile: this.profile,
        source: this.source,
        gateOpen: this.gateOpen,
        rms,
        noiseFloor: this.noiseFloor,
        openThreshold,
        closeThreshold,
        gain: this.currentGain,
        closedGain: this.config.closedGain
      });
    }

    return true;
  }
}

registerProcessor("sovchat-voice-gate", SovChatVoiceGateProcessor);
