// Compress GIF — reduce GIF file size via FFmpeg palettegen/paletteuse.
//
// Quality is controlled by a level select (Smaller / Balanced / Better) that
// maps to frame-rate and palette-color-count settings. Lower fps + fewer palette
// colours → smaller file; higher fps + more palette colours → better quality.
//
// Level settings:
//   Smaller  — fps=8,  palette colors=64
//   Balanced — fps=12, palette colors=128
//   Better   — fps=15, palette colors=256
//
// The filtergraph pattern is the same as MP4→GIF: fps filter → scale (preserve
// size, no resize) → split → palettegen (with max_colors) → paletteuse.
// We preserve the original width (scale=-1 keeps aspect; we don't resize the
// GIF — the user asked only to compress, not to resize).
//
// Engine: multi-threaded ffmpeg core (same as MP4→GIF). The page carries
// COOP + COEP headers so SharedArrayBuffer is available for pthreads.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";

const IN_NAME = "input.gif";
const OUT_NAME = "output.gif";

type Level = "Smaller" | "Balanced" | "Better";

interface LevelSettings {
  fps: number;
  colors: number;
}

const LEVEL_SETTINGS: Record<Level, LevelSettings> = {
  Smaller:  { fps: 8,  colors: 64  },
  Balanced: { fps: 12, colors: 128 },
  Better:   { fps: 15, colors: 256 },
};

const DEFAULT_LEVEL: Level = "Balanced";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

function isGifFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/gif") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "gif";
  }
  return false;
}

function resolveLevel(value: unknown): Level {
  if (value === "Smaller" || value === "Balanced" || value === "Better") return value;
  return DEFAULT_LEVEL;
}

async function convertCompressGif(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isGifFile(file)) {
    throw new ConversionError("This doesn't look like a GIF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected image/gif, received "${file.type || "unknown type"}".`,
    });
  }

  const level = resolveLevel(options?.level);
  const { fps, colors } = LEVEL_SETTINGS[level];

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Compressing" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Compressing", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // fps=N         — reduce frame rate to target fps
  // scale=iw:-1   — preserve original width (iw = input width), auto height
  // flags=lanczos — high-quality resampling (no-op for same-size, no harm)
  // split[s0][s1] — fork stream for palettegen + paletteuse
  // palettegen=max_colors=N — build optimal palette with at most N colours
  // paletteuse    — apply palette to each frame with dithering
  const vf = `fps=${fps},scale=iw:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${colors}[p];[s1][p]paletteuse`;

  const FFMPEG_ARGS = [
    "-i", IN_NAME,
    "-vf", vf,
    OUT_NAME,
  ];

  let result: { data: Uint8Array; exitCode: number };
  try {
    result = await runFFmpeg(ffmpeg, {
      inName: IN_NAME,
      outName: OUT_NAME,
      input: inputBytes,
      args: FFMPEG_ARGS,
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
      "We couldn't compress this file. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: err instanceof Error ? err.message : String(err),
      },
    );
  } finally {
    if (onProgress) ffmpeg.off("progress", onFfmpegProgress);
  }

  throwIfAborted(signal);

  if (result.exitCode !== 0 || result.data.byteLength === 0) {
    throw new ConversionError(
      "We couldn't compress this file. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: "image/gif" });

  return {
    blob,
    filename: replaceExtension(file.name, "gif"),
    mimeType: "image/gif",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const compressGifDescriptor: ConversionDescriptor = {
  id: "compress-gif",
  fromLabel: "GIF",
  toLabel: "Compressed",
  accept: ["image/gif"],
  newExtension: "gif",
  // Many files at once, each with its own level, converted independently.
  inputMode: "multi-compress",
  defaultOptions: { level: DEFAULT_LEVEL },
  controls: [
    {
      type: "select",
      id: "level",
      label: "Compression level",
      help: "Smaller produces the tiniest file; Better keeps more frames and colours at a larger size.",
      default: DEFAULT_LEVEL,
      options: [
        { value: "Smaller",  label: "Smaller — fewer frames, fewer colours" },
        { value: "Balanced", label: "Balanced — a good size/quality tradeoff" },
        { value: "Better",   label: "Better — more frames, more colours" },
      ],
    },
  ],
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  setupSizeLabel: "≈ 26 MB",
  convert: convertCompressGif,
};
