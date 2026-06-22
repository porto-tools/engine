// Flip video — mirrors an MP4 horizontally, vertically, or both.
//
// FFmpeg command: `ffmpeg -i input.mp4 -vf <filter> -b:v <n> -c:a copy output.mp4`
//   -vf hflip          mirror left↔right
//   -vf vflip          mirror top↔bottom
//   -vf "hflip,vflip"  both (equivalent to a 180° rotation)
//   -c:a copy          stream-copy the audio (only the video is filtered)
//
// Because the `-vf` filter forces the video to be decoded and re-encoded, the
// audio is the only stream we can pass through untouched (-c:a copy). Re-encoding
// would otherwise fall back to openh264's low default bitrate and badly downgrade
// the picture; pin the video bitrate to the source's budget like reverse-video.
//
// A single 'select' control ("direction") chooses the mirror axis.
//
// Engine: the multi-threaded core (consistent with other video tools; MT is
// ~2× faster for the decode/encode round-trip that flipping requires).

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg, probeVideoDuration, recommendedVideoBitrate } from "./ffmpeg-core";

const IN_NAME  = "input.mp4";
const OUT_NAME = "output.mp4";

type Direction = "Horizontal" | "Vertical" | "Both";

const DIRECTION_FILTER: Record<Direction, string> = {
  Horizontal: "hflip",
  Vertical:   "vflip",
  Both:       "hflip,vflip",
};

const DEFAULT_DIRECTION: Direction = "Horizontal";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

function isMp4File(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/mp4") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "mp4";
  }
  return false;
}

function resolveDirection(value: unknown): Direction {
  if (value === "Horizontal" || value === "Vertical" || value === "Both") return value;
  return DEFAULT_DIRECTION;
}

async function convertFlipVideo(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  const direction = resolveDirection(options?.direction);
  const filter = DIRECTION_FILTER[direction];

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Flipping" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Flipping", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // The `-vf` filter forces a video re-encode; pin the bitrate to the source's
  // budget so openh264 doesn't fall back to its low default and downgrade the
  // picture. The audio is untouched, so we stream-copy it (-c:a copy).
  const targetBitrate = recommendedVideoBitrate(file.size, await probeVideoDuration(file));

  const FFMPEG_ARGS = [
    "-i",   IN_NAME,
    "-vf",  filter,
    "-b:v", String(targetBitrate),
    "-c:a", "copy",
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
      "We couldn't flip this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't flip this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
      {
        code: "DECODE_FAILED",
        recoverable: true,
        technical: `ffmpeg exited with code ${result.exitCode}, output ${result.data.byteLength} bytes.`,
      },
    );
  }

  const blob = new Blob([result.data.slice().buffer], { type: "video/mp4" });

  return {
    blob,
    filename: replaceExtension(file.name, "mp4"),
    mimeType: "video/mp4",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const flipVideoDescriptor: ConversionDescriptor = {
  id: "flip-video",
  fromLabel: "MP4",
  toLabel: "Flipped MP4",
  accept: ["video/mp4"],
  newExtension: "mp4",
  defaultOptions: { direction: DEFAULT_DIRECTION },
  controls: [
    {
      type: "select",
      id: "direction",
      label: "Flip direction",
      help: "Horizontal mirrors left-to-right; vertical mirrors top-to-bottom; both flips on both axes.",
      default: DEFAULT_DIRECTION,
      options: [
        { value: "Horizontal", label: "Horizontal — mirror left-to-right" },
        { value: "Vertical",   label: "Vertical — mirror top-to-bottom" },
        { value: "Both",       label: "Both — flip on both axes" },
      ],
    },
  ],
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  // The MT core (ffmpeg-core.js + .wasm + .worker.js) is the one-time download
  // shown in the setup state while loadEngine runs.
  setupSizeLabel: "≈ 26 MB",
  convert: convertFlipVideo,
};
