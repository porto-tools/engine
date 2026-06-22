// Shared Canvas primitives for the WASM-free image conversions (PNG↔JPG and
// friends): input-type guarding, decode to ImageBitmap, draw onto a 2D canvas,
// and encode via canvas.toBlob. All lifted verbatim from png-jpg so the codes,
// messages, and behavior are byte-identical.
//
// Engine firewall: this file imports ONLY the sibling types module and
// node_modules. It never reaches into app/components/lib. See types.ts.

import { ConversionError } from "../types";

// Reject the wrong format up front with a non-recoverable error — retrying the
// same file can't help; the user needs a different file (or a different tool).
export function assertSupported(file: File, accept: string[], fromLabel: string): void {
  if (!accept.includes(file.type)) {
    throw new ConversionError(`This doesn't look like a ${fromLabel} file.`, {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected one of [${accept.join(", ")}], received "${file.type || "unknown type"}".`,
    });
  }
}

// Decode the input into an ImageBitmap. A decode failure means the bytes are
// damaged or mislabelled — not recoverable by retry.
export async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    throw new ConversionError("We couldn't read this image — the file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

// Promisified canvas.toBlob. A null blob (encoder refused) is recoverable —
// it's usually a transient memory pinch, so the UI offers a retry.
export function encode(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else
          reject(
            new ConversionError("We couldn't finish encoding this image.", {
              code: "ENCODE_FAILED",
              recoverable: true,
              technical: `canvas.toBlob returned null for ${mimeType}.`,
            }),
          );
      },
      mimeType,
      quality,
    );
  });
}

// Acquire the 2D drawing context, throwing the canonical CANVAS_UNAVAILABLE
// error if the browser refuses it. Extracted verbatim from drawToCanvas so the
// context-acquisition logic lives in one place; the error code and message are
// unchanged.
export function getContext2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ConversionError("Your browser couldn't open a drawing canvas.", {
      code: "CANVAS_UNAVAILABLE",
      recoverable: false,
      technical: "HTMLCanvasElement.getContext('2d') returned null.",
    });
  }
  return ctx;
}

// Draw a decoded bitmap onto a fresh canvas. When `background` is given (JPG
// output), fill it first so transparent PNG regions flatten to a solid colour
// instead of turning black — JPG has no alpha channel.
export function drawToCanvas(bitmap: ImageBitmap, background?: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = getContext2D(canvas);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}
