// WAV → MP3. Mirrors the mp3-wav.ts pattern exactly.
//
// WAV is uncompressed LPCM; MP3 is lossy compressed. FFmpeg reads the raw PCM
// samples from the WAV container, encodes them with libmp3lame at 192 kbps, and
// writes an MP3 file: `ffmpeg -i input.wav -b:a 192k output.mp3`. The 192 kbps
// setting is a good-quality default — high enough for music, reasonable for
// speech. Expect the MP3 to be considerably smaller than the WAV source.
//
// Engine: single-threaded core (decision 0009 §3). No COOP/COEP needed.
//
// MIME note: WAV files are inconsistently typed across browsers and OS pickers.
// The standard is "audio/wav" but "audio/x-wav", "audio/wave", and
// "audio/vnd.wave" are all observed in the wild. We also tolerate empty MIME
// when the extension is .wav.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";
import {
  buildAudioArgs,
  sampleRateControl,
  channelsControl,
  volumeControl,
  reverseControl,
  bitrateControl,
  vbrControl,
  trimControls,
  fadeControls,
  type AudioSettingsOptions,
} from "./audio-settings";

const IN_NAME = "input.wav";
const OUT_NAME = "output.mp3";

// ── Advanced audio settings ─────────────────────────────────────────────────
//
// WAV→MP3 composes the shared audio drawer: bitrate + VBR + sample rate /
// channels / volume / reverse, plus trim + fade. The DEFAULTS reproduce the
// original `-i input.wav -b:a 192k output.mp3`: bitrate defaults to 192k (the
// value the route always used) with VBR off, and everything else is a no-op
// ("Auto" / 100% / blank). Pass no options and the assembled args — and so the
// output — are unchanged.
//
// MP3 is lossy via libmp3lame: codec.ffmpegArgs = ["-c:a","libmp3lame"]. The
// shared builder emits `-b:a <bitrate>` (CBR, default) or, with VBR on, a
// `-q:a <V>` quality flag mapped from the chosen bitrate.

// Pure: assemble the full ffmpeg arg array for WAV→MP3 from (validated) options.
// Defaults reproduce the original `-i input.wav -b:a 192k output.mp3` exactly.
export function buildWavMp3Args(options: AudioSettingsOptions | undefined = {}): string[] {
  return buildAudioArgs({
    inName: IN_NAME,
    outName: OUT_NAME,
    codec: { lossy: true, ffmpegArgs: ["-c:a", "libmp3lame"], vbrEncoder: "libmp3lame" },
    options,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

// Accept all common WAV MIME types, and tolerate empty MIME with a .wav extension.
function isWavFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (
    type === "audio/wav" ||
    type === "audio/x-wav" ||
    type === "audio/wave" ||
    type === "audio/vnd.wave"
  )
    return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "wav";
  }
  return false;
}

async function convertWavToMp3(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isWavFile(file)) {
    throw new ConversionError("This doesn't look like a WAV file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected audio/wav (or variant), received "${file.type || "unknown type"}".`,
    });
  }

  const ffmpeg = await loadFFmpeg("st");

  throwIfAborted(signal);

  onProgress?.({ stage: "Converting" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Converting", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  let result: { data: Uint8Array; exitCode: number };
  try {
    result = await runFFmpeg(ffmpeg, {
      inName: IN_NAME,
      outName: OUT_NAME,
      input: inputBytes,
      args: buildWavMp3Args(options as AudioSettingsOptions | undefined),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new ConversionError("Conversion cancelled.", {
        code: "CANCELLED",
        recoverable: true,
      });
    }
    throw new ConversionError(
      "We couldn't convert this audio — the file may be damaged or not a valid WAV.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      },
    );
  } finally {
    if (onProgress) ffmpeg.off("progress", onFfmpegProgress);
  }

  throwIfAborted(signal);

  if (result.exitCode !== 0 || result.data.byteLength === 0) {
    throw new ConversionError(
      "We couldn't convert this audio — the file may be damaged or not a valid WAV.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: "audio/mpeg" });

  return {
    blob,
    filename: replaceExtension(file.name, "mp3"),
    mimeType: "audio/mpeg",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const wavMp3Descriptor: ConversionDescriptor = {
  id: "wav-to-mp3",
  fromLabel: "WAV",
  toLabel: "MP3",
  accept: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  newExtension: "mp3",
  // Advanced audio settings. Defaults reproduce the original `-b:a 192k` encode
  // (bitrate 192k + VBR off, the rest "Auto"/100%/blank), so the out-of-the-box
  // result is byte-identical to before.
  defaultOptions: {
    bitrate: "192k",
    vbr: false,
    sampleRate: "auto",
    channels: "auto",
    volume: 100,
    reverse: false,
    trimStart: "",
    trimEnd: "",
    fadeIn: 0,
    fadeOut: 0,
  },
  controls: [
    bitrateControl("192k"),
    vbrControl(),
    sampleRateControl(),
    channelsControl(),
    volumeControl(),
    reverseControl(),
    ...trimControls(),
    ...fadeControls(),
  ],
  loadEngine: async () => {
    await loadFFmpeg("st");
  },
  setupSizeLabel: "≈ 24 MB",
  convert: convertWavToMp3,
};
