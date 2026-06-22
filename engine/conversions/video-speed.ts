// Video speed change — speed up or slow down an MP4.
//
// Uses a filter_complex graph to adjust both video presentation timestamps
// (PTS) and the audio tempo independently:
//
//   Video: setpts=<1/speed>*PTS — scales presentation timestamps so the video
//          plays at the requested speed. Values <1 slow down, >1 speed up.
//
//   Audio: atempo=<speed> — adjusts playback tempo without changing pitch.
//          The atempo filter only accepts values in [0.5, 2.0]. For speed
//          values outside that range we CHAIN multiple atempo filters:
//            0.5 → atempo=0.5  (single stage: 0.5 is the minimum)
//            1.5 → atempo=1.5  (single stage)
//            2.0 → atempo=2.0  (single stage: 2.0 is the maximum)
//            4.0 → atempo=2.0,atempo=2.0  (chained: 2.0 × 2.0 = 4.0)
//
//   No-audio inputs: When the input has no audio stream, the -map "[a]" would
//   fail. We detect this by probing the file: if ffmpeg reports no audio stream
//   we fall back to a video-only filter_complex that omits the atempo chain and
//   the -map "[a]" argument.
//
// Engine: the multi-threaded core (decision 0009 §3).

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg, probeVideoDuration, recommendedVideoBitrate } from "./ffmpeg-core";

const IN_NAME = "input.mp4";
const OUT_NAME = "output.mp4";

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

// Build the atempo filter chain for a given speed. atempo only accepts [0.5,
// 2.0], so values outside that range are expressed as a product of stages.
//   0.5 → "atempo=0.5"
//   1.5 → "atempo=1.5"
//   2   → "atempo=2.0"
//   4   → "atempo=2.0,atempo=2.0"
export function buildAtempoChain(speed: number): string {
  // Walk down from the target speed, clamping each stage to [0.5, 2.0].
  const stages: string[] = [];
  let remaining = speed;
  while (remaining > 2.0 + 1e-9) {
    stages.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5 - 1e-9) {
    stages.push("atempo=0.5");
    remaining /= 0.5;
  }
  // Final stage with whatever is left.
  stages.push(`atempo=${remaining.toFixed(4).replace(/\.?0+$/, "")}`);
  return stages.join(",");
}

async function convertVideoSpeed(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  // Read and validate the speed option. Fall back to "2" (2× speed-up) if missing.
  const rawSpeed = typeof options?.speed === "string" ? options.speed : String(options?.speed ?? "2");
  const speed = parseFloat(rawSpeed);
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new ConversionError("Invalid speed value. Choose 0.5×, 1.5×, 2×, or 4×.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
      technical: `options.speed was "${options?.speed}", parsed as ${speed}.`,
    });
  }

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Processing" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Processing", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  // We read the input bytes fresh from the File for EACH ffmpeg pass below.
  // @ffmpeg/ffmpeg's writeFile transfers (detaches) the Uint8Array's backing
  // ArrayBuffer into the worker, so a single buffer cannot be written twice — and
  // this tool writes twice (an audio-probe pass, then the real speed pass).
  // file.arrayBuffer() hands back a brand-new buffer each call, so each pass gets
  // its own owned bytes; the File itself is the durable source. (runFFmpeg also
  // clones defensively, but reading fresh here keeps the two passes independent
  // and survives any internal retry/fallback that re-writes the input.)
  throwIfAborted(signal);

  // First pass: probe for an audio stream using -map 0:a -c copy -f null.
  // If the exit code is non-zero there is no audio track.
  let hasAudio = false;
  {
    const probeArgs = ["-i", IN_NAME, "-map", "0:a", "-c", "copy", "-f", "null", "-"];
    try {
      const probeOut = await runFFmpeg(ffmpeg, {
        inName: IN_NAME,
        outName: "-",
        input: new Uint8Array(await file.arrayBuffer()),
        args: probeArgs,
        signal,
      });
      hasAudio = probeOut.exitCode === 0;
    } catch {
      hasAudio = false;
    }
  }

  throwIfAborted(signal);

  const ptsMultiplier = (1 / speed).toFixed(6);

  // Setpts forces a re-encode; pin the bitrate to the source's quality budget so
  // the output keeps its resolution AND fidelity (without this, openh264's low
  // default makes a 720p clip look like 180p).
  const targetBitrate = recommendedVideoBitrate(file.size, await probeVideoDuration(file));

  let FFMPEG_ARGS: string[];
  if (hasAudio) {
    const atempoChain = buildAtempoChain(speed);
    // filter_complex fans the input into two streams:
    //   [0:v] → setpts (video speed)
    //   [0:a] → atempo chain (audio tempo)
    // then maps both to the output.
    FFMPEG_ARGS = [
      "-i", IN_NAME,
      "-filter_complex",
      `[0:v]setpts=${ptsMultiplier}*PTS[v];[0:a]${atempoChain}[a]`,
      "-map", "[v]",
      "-map", "[a]",
      "-b:v", String(targetBitrate),
      "-b:a", "192k",
      OUT_NAME,
    ];
  } else {
    // No audio stream — video-only filter.
    FFMPEG_ARGS = [
      "-i", IN_NAME,
      "-filter_complex",
      `[0:v]setpts=${ptsMultiplier}*PTS[v]`,
      "-map", "[v]",
      "-an",
      "-b:v", String(targetBitrate),
      OUT_NAME,
    ];
  }

  let result: { data: Uint8Array; exitCode: number };
  try {
    result = await runFFmpeg(ffmpeg, {
      inName: IN_NAME,
      outName: OUT_NAME,
      // Fresh owned bytes again — the probe pass above already detached its copy.
      input: new Uint8Array(await file.arrayBuffer()),
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
      "We couldn't change the speed of this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't change the speed of this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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

export const videoSpeedDescriptor: ConversionDescriptor = {
  id: "video-speed",
  fromLabel: "MP4",
  toLabel: "Speed-adjusted MP4",
  accept: ["video/mp4"],
  newExtension: "mp4",
  defaultOptions: { speed: "2" },
  // A discrete draggable slider (YouTube/volume style): the thumb snaps to these
  // stops; the emitted value is the numeric multiplier itself. 0.1 steps up to
  // 1.0, then 0.25 steps up to 4.0; 1× is the neutral anchor. convertVideoSpeed
  // reads options.speed as the numeric multiplier (parseFloat on string|number).
  controls: [
    {
      type: "slider",
      id: "speed",
      label: "Playback speed",
      help: "Drag to set the multiplier applied to the video. Below 1× slows it down; above 1× speeds it up.",
      default: 2,
      stops: [
        0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0,
        3.25, 3.5, 3.75, 4.0,
      ],
      unit: "×",
      anchor: 1.0,
    },
  ],
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  setupSizeLabel: "≈ 26 MB",
  convert: convertVideoSpeed,
};
