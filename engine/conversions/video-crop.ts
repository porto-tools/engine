// Video crop — cut a rectangular region from an MP4.
//
// Uses ffmpeg's `crop` video filter: crop=w:h:x:y where w/h are the output
// dimensions and x/y is the top-left corner of the crop region. The filter
// requires a full re-encode (stream copy cannot apply filters), so this is a
// transcoding pass.
//
// Codec: copy-compatible re-encode at default H.264/AAC quality to keep
// output compatible and file size reasonable. The audio stream is copied
// (`-c:a copy`) since cropping does not affect audio.
//
// Controls: none on the descriptor — the crop-video page drives the four crop
// keys (cropX/cropY/cropW/cropH) with a custom visual crop box (see
// CropVideoTool), passing them as `options`. The engine sanitises that geometry
// (see resolveCropGeometry): each axis is clamped to [.., MAX_CROP_PX] and the
// offsets are pulled inside that frame cap, so oversized/tampered options can't
// build a pathological crop=… argument. Geometry that is still invalid against
// the actual source frame (e.g. x+w > the real video width) is left for ffmpeg
// to reject, surfaced as DECODE_FAILED.
//
// H.264 (yuv420p) requires EVEN output dimensions, so cropW/cropH are floored to
// the nearest even value before the filter is built (an odd width/height would
// make the encoder fail). The minimum is 2 px on each axis.
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

// Upper bound for any single crop axis (px). H.264 level 6.2 tops out at 8192×4320,
// so 8192 is a generous ceiling that no legitimate browser-decodable clip exceeds.
// Clamping here keeps malformed/oversized options (e.g. from a tampered request)
// from reaching ffmpeg as a pathological crop=… string; ffmpeg would reject them,
// but defending in depth means we never build that argument in the first place.
const MAX_CROP_PX = 8192;

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

// Read a crop dimension option, clamping to a positive integer in
// [1, MAX_CROP_PX]. When the value is missing or non-numeric, falls back to
// `fallback`. The upper cap stops oversized/tampered geometry from reaching
// ffmpeg as a pathological crop=… argument (defence in depth — ffmpeg would
// reject it too, but we never build that string).
function readCropInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_CROP_PX, Math.round(n));
}

// Read a crop offset (x/y) option, clamping to a non-negative integer no larger
// than MAX_CROP_PX. Missing/non-numeric values fall back to 0.
function readCropOffset(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_CROP_PX, Math.round(n));
}

// Resolve the four crop options into the sanitised w/h/x/y the ffmpeg crop
// filter receives. Width/height are floored to even (H.264) and every axis is
// clamped to [.., MAX_CROP_PX]; offsets are pulled in so x+w and y+h stay inside
// the frame cap. Exported for unit testing the clamp logic without the runtime.
export function resolveCropGeometry(options: {
  cropW?: unknown;
  cropH?: unknown;
  cropX?: unknown;
  cropY?: unknown;
} = {}): { w: number; h: number; x: number; y: number } {
  const w = toEven(readCropInt(options.cropW, 640));
  const h = toEven(readCropInt(options.cropH, 480));
  const x = Math.min(readCropOffset(options.cropX), MAX_CROP_PX - w);
  const y = Math.min(readCropOffset(options.cropY), MAX_CROP_PX - h);
  return { w, h, x, y };
}

// Floor a width/height to the nearest EVEN value (minimum 2). H.264 with yuv420p
// chroma subsampling can only encode even dimensions; an odd one makes the
// encoder fail, so we trim at most one pixel off rather than surface an error.
function toEven(n: number): number {
  const even = n - (n % 2);
  return even < 2 ? 2 : even;
}

async function convertVideoCrop(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isMp4File(file)) {
    throw new ConversionError("This doesn't look like an MP4 file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected video/mp4, received "${file.type || "unknown type"}".`,
    });
  }

  // Sanitise the crop geometry: even (H.264) dimensions, every axis clamped to
  // MAX_CROP_PX, offsets pulled in so x+w / y+h stay inside the frame cap.
  const { w, h, x, y } = resolveCropGeometry(options ?? {});

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Cropping" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Cropping", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // The crop filter forces a full video re-encode; pin the bitrate to the
  // source's budget so the output keeps its fidelity (without this, openh264's
  // low default makes a 720p clip look like 180p).
  const targetBitrate = recommendedVideoBitrate(file.size, await probeVideoDuration(file));

  // -vf crop=w:h:x:y  — crop filter: output region w×h starting at (x,y)
  // -b:v <bitrate>    — match the source's quality budget (re-encode preserves fidelity)
  // -c:a copy         — audio unchanged (cropping is video-only)
  const FFMPEG_ARGS = [
    "-i", IN_NAME,
    "-vf", `crop=${w}:${h}:${x}:${y}`,
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
      "We couldn't crop this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't crop this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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

export const videoCropDescriptor: ConversionDescriptor = {
  id: "video-crop",
  fromLabel: "MP4",
  toLabel: "Cropped MP4",
  accept: ["video/mp4"],
  newExtension: "mp4",
  // No `controls`: the crop-video page renders a custom visual crop box
  // (CropVideoTool) that drives cropX/cropY/cropW/cropH as `options`. These
  // defaults remain the engine-side fallback for any missing key.
  defaultOptions: { cropW: 640, cropH: 480, cropX: 0, cropY: 0 },
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  setupSizeLabel: "≈ 26 MB",
  convert: convertVideoCrop,
};
