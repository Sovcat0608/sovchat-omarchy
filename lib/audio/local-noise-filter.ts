import {
  RnnoiseWorkletNode,
  loadRnnoise
} from "@sapphi-red/web-noise-suppressor";
import {
  Track,
  type AudioProcessorOptions,
  type TrackProcessor
} from "livekit-client";

const RNNOISE_WORKLET_URL = "/audio-worklets/sovchat-rnnoise-processor.js";
const RNNOISE_WASM_URL = "/audio-models/rnnoise.wasm";
const RNNOISE_SIMD_WASM_URL = "/audio-models/rnnoise_simd.wasm";

let rnnoiseWasmPromise: Promise<ArrayBuffer> | null = null;
const rnnoiseWorkletLoaders = new WeakMap<AudioContext, Promise<void>>();

function getRnnoiseWasm() {
  if (!rnnoiseWasmPromise) {
    rnnoiseWasmPromise = loadRnnoise(
      {
        url: RNNOISE_WASM_URL,
        simdUrl: RNNOISE_SIMD_WASM_URL
      },
      { cache: "force-cache" }
    ).catch((error) => {
      rnnoiseWasmPromise = null;
      throw error;
    });
  }

  return rnnoiseWasmPromise;
}

function loadRnnoiseWorklet(audioContext: AudioContext) {
  const existingLoader = rnnoiseWorkletLoaders.get(audioContext);
  if (existingLoader) {
    return existingLoader;
  }

  const loader = audioContext.audioWorklet.addModule(RNNOISE_WORKLET_URL).catch((error) => {
    rnnoiseWorkletLoaders.delete(audioContext);
    throw error;
  });
  rnnoiseWorkletLoaders.set(audioContext, loader);
  return loader;
}

export function isLocalNoiseFilterSupported() {
  return (
    typeof window !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    "audioWorklet" in AudioContext.prototype
  );
}

export async function prewarmLocalNoiseFilter(signal?: AbortSignal) {
  if (!isLocalNoiseFilterSupported()) {
    throw new Error("Local RNNoise filtering is not supported in this runtime.");
  }
  if (signal?.aborted) {
    throw new DOMException("Noise filter prewarm was cancelled.", "AbortError");
  }

  const wasmPromise = getRnnoiseWasm();
  if (!signal) {
    await wasmPromise;
    return;
  }

  await Promise.race([
    wasmPromise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Noise filter prewarm was cancelled.", "AbortError")),
        { once: true }
      );
    })
  ]);
}

export class LocalNoiseFilterProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "sovchat-local-rnnoise-filter";
  processedTrack?: MediaStreamTrack;

  private enabled = true;
  private inputTrack?: MediaStreamTrack;
  private sourceNode?: MediaStreamAudioSourceNode;
  private filterNode?: RnnoiseWorkletNode;
  private destinationNode?: MediaStreamAudioDestinationNode;

  async setEnabled(enable: boolean) {
    this.enabled = enable;
    this.connectGraph();
    return true;
  }

  isEnabled() {
    return this.enabled;
  }

  async init(opts: AudioProcessorOptions) {
    if (!isLocalNoiseFilterSupported()) {
      throw new Error("Local RNNoise filtering is not supported in this runtime.");
    }
    if (opts.audioContext.sampleRate !== 48_000) {
      throw new Error(`RNNoise requires a 48 kHz audio context; received ${opts.audioContext.sampleRate} Hz.`);
    }

    const [wasmBinary] = await Promise.all([
      getRnnoiseWasm(),
      loadRnnoiseWorklet(opts.audioContext)
    ]);

    this.inputTrack = opts.track;
    this.sourceNode = opts.audioContext.createMediaStreamSource(new MediaStream([opts.track]));
    this.filterNode = new RnnoiseWorkletNode(opts.audioContext, {
      maxChannels: 1,
      wasmBinary
    });
    this.destinationNode = opts.audioContext.createMediaStreamDestination();
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0] ?? opts.track;
    this.connectGraph();
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.sourceNode?.disconnect();
    this.filterNode?.disconnect();
    this.destinationNode?.disconnect();
    this.filterNode?.destroy();

    if (this.processedTrack && this.processedTrack !== this.inputTrack) {
      this.processedTrack.stop();
    }

    this.inputTrack = undefined;
    this.sourceNode = undefined;
    this.filterNode = undefined;
    this.destinationNode = undefined;
    this.processedTrack = undefined;
  }

  private connectGraph() {
    if (!this.sourceNode || !this.filterNode || !this.destinationNode) {
      return;
    }

    this.sourceNode.disconnect();
    this.filterNode.disconnect();

    if (this.enabled) {
      this.sourceNode.connect(this.filterNode);
      this.filterNode.connect(this.destinationNode);
      return;
    }

    this.sourceNode.connect(this.destinationNode);
  }
}
