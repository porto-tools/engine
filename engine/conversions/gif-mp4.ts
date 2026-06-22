// GIF → MP4. Converts an animated GIF to a broad-compatibility H.264/MP4.
//
// GIF files are palette-indexed images with animation encoded frame-by-frame.
// Converting to MP4 shrinks them dramatically — a 5 MB GIF typically compresses
// to a fraction of that as H.264. The result plays natively in every modern
// browser and OS without any plugin. Audio is not present in GIF files.
//
// Encoder: libopenh264 (Cisco's open-source H.264). This is the FIRST use of
// the libopenh264 encoder in the codebase — also used by WEBM→MP4. It produces
// standard Baseline H.264 with broad device compatibility. yuv420p is required
// for QuickTime/iOS/Safari playback; +faststart moves the moov atom to the front
// so the browser can play before the full file is downloaded.
//
// Engine: the multi-threaded core (decision 0009 §3). All video routes share the
// MT core and carry COOP + COEP headers (public/_headers) for SharedArrayBuffer.
//
// MIME note: browsers report dropped .gif files as "image/gif", but some OS file
// pickers report "" or an alias. We accept the standard type and tolerate empty
// MIME when the extension is .gif — matching the pattern established in MP4→GIF.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { loadFFmpeg, runFFmpeg } from "./ffmpeg-core";

const IN_NAME = "input.gif";
const OUT_NAME = "output.mp4";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

// Accept image/gif (standard) and tolerate empty MIME when the extension is
// .gif, mirroring the tolerance in the MP4→GIF route.
function isGifFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/gif") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "gif";
  }
  return false;
}

async function convertGifToMp4(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isGifFile(file)) {
    throw new ConversionError("This doesn't look like a GIF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected image/gif, received "${file.type || "unknown type"}".`,
    });
  }

  const ffmpeg = await loadFFmpeg("mt");

  throwIfAborted(signal);

  onProgress?.({ stage: "Converting" });

  const onFfmpegProgress = ({ progress }: { progress: number; time: number }) => {
    const ratio = Math.min(1, Math.max(0, progress));
    onProgress?.({ stage: "Converting", ratio });
  };
  if (onProgress) ffmpeg.on("progress", onFfmpegProgress);

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  // -i input.gif            — read GIF (each frame decoded by libgif decoder)
  // -movflags +faststart    — relocate moov atom so streaming/browser playback
  //                           begins before the full file is downloaded
  // -pix_fmt yuv420p        — required for QuickTime/iOS/Safari compatibility
  // -c:v libopenh264        — Cisco's open-source H.264 encoder; Baseline profile,
  //                           broad device support. Note: no -b:v set so it uses
  //                           the encoder default (~600 kbps). GIF→MP4 typically
  //                           compresses dramatically regardless.
  const FFMPEG_ARGS = [
    "-i", IN_NAME,
    "-movflags", "+faststart",
    "-pix_fmt", "yuv420p",
    "-c:v", "libopenh264",
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
      "We couldn't convert this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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
      "We couldn't convert this video. It may be too large to finish in your browser's memory — try a shorter clip or a lower resolution — or the file may be damaged or in an unsupported format.",
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

export const gifMp4Descriptor: ConversionDescriptor = {
  id: "gif-to-mp4",
  fromLabel: "GIF",
  toLabel: "MP4",
  accept: ["image/gif"],
  newExtension: "mp4",
  // Loads the multi-threaded ffmpeg core (decision 0009). The MT core requires
  // cross-origin isolation (COOP + COEP headers, public/_headers).
  loadEngine: async () => {
    await loadFFmpeg("mt");
  },
  // The MT core (ffmpeg-core.js + .wasm + .worker.js) is the one-time download
  // shown in the setup state while loadEngine runs.
  setupSizeLabel: "≈ 26 MB",
  convert: convertGifToMp4,
};
