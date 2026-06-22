// OGG → MP3. Mirrors wav-mp3.ts / m4a-mp3.ts exactly.
//
// OGG here means Ogg Vorbis (the common .ogg case); MP3 is also lossy. FFmpeg
// decodes the Vorbis stream and re-encodes with libmp3lame at 192 kbps:
//   `ffmpeg -i input.ogg -c:a libmp3lame -b:a 192k output.mp3`
// Because both source and output are lossy, there is a small generation-loss
// quality cost from re-encoding — the same cost as any lossy→lossy transcode.
// The resulting MP3 is maximally compatible with players that do not support OGG.
//
// The shipped LGPL ffmpeg core already bundles the Vorbis decoder and libmp3lame
// encoder (used by audio-converter.ts FORMAT_CONFIG), so this route is 0-dep. The
// core also decodes Opus-in-Ogg, so a .ogg holding Opus is handled too.
//
// Engine: single-threaded core (decision 0009 §3). No COOP/COEP needed.
//
// MIME note: OGG is reported as "audio/ogg" (standard), "application/ogg", or
// "audio/vorbis"; .oga is an alternate audio-only Ogg extension. We also tolerate
// empty MIME when the extension is .ogg or .oga.

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

const IN_NAME = "input.ogg";
const OUT_NAME = "output.mp3";

// ── Advanced audio settings ─────────────────────────────────────────────────
//
// OGG→MP3 composes the shared audio drawer: bitrate + VBR + sample rate /
// channels / volume / reverse, plus trim + fade. The DEFAULTS reproduce
// `-i input.ogg -c:a libmp3lame -b:a 192k output.mp3`: bitrate defaults to 192k
// with VBR off, and everything else is a no-op ("Auto" / 100% / blank).
//
// MP3 is lossy via libmp3lame: codec.ffmpegArgs = ["-c:a","libmp3lame"]. The
// shared builder emits `-b:a <bitrate>` (CBR, default) or, with VBR on, a
// `-q:a <V>` quality flag mapped from the chosen bitrate.

// Pure: assemble the full ffmpeg arg array for OGG→MP3 from (validated) options.
export function buildOggMp3Args(options: AudioSettingsOptions | undefined = {}): string[] {
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

// Accept audio/ogg (standard), application/ogg, audio/vorbis; tolerate empty MIME
// with a .ogg or .oga extension.
function isOggFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "audio/ogg" || type === "application/ogg" || type === "audio/vorbis") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "ogg" || ext === "oga";
  }
  return false;
}

async function convertOggToMp3(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isOggFile(file)) {
    throw new ConversionError("This doesn't look like an OGG file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected audio/ogg (or variant), received "${file.type || "unknown type"}".`,
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
      args: buildOggMp3Args(options as AudioSettingsOptions | undefined),
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
      "We couldn't convert this audio — the file may be damaged or not a valid OGG.",
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
      "We couldn't convert this audio — the file may be damaged or not a valid OGG.",
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

export const oggMp3Descriptor: ConversionDescriptor = {
  id: "ogg-to-mp3",
  fromLabel: "OGG",
  toLabel: "MP3",
  accept: ["audio/ogg", "application/ogg", "audio/vorbis"],
  newExtension: "mp3",
  // Advanced audio settings. Defaults reproduce a plain `-b:a 192k` encode
  // (bitrate 192k + VBR off, the rest "Auto"/100%/blank).
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
  convert: convertOggToMp3,
};
