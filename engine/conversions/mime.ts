// Shared MIME-type constants for the WASM-free raster-image conversions.
//
// Several Canvas-based image tools (compress-image, image-crop, image-flip,
// image-resize, image-rotate, image-upscale, remove-background) accepted the
// SAME three input rasters and mapped them to the SAME output extensions. Each
// tool had previously redeclared these two structures inline. They are
// consolidated here verbatim — members AND order unchanged — so the data lives
// in one place without altering any tool's behavior.
//
// ORDER IS LOAD-BEARING: RASTER_IMAGE_ACCEPT feeds each tool's assertSupported,
// which throws UNSUPPORTED_INPUT with a `technical` string of the form
// `Expected one of [${ACCEPT.join(", ")}], received "…"`. The join reproduces
// the array order, so this const MUST stay byte-identical to the arrays it
// replaced. Do not reorder.
//
// Engine firewall: this file is pure data — it imports NOTHING (not even the
// sibling types module). It drops cleanly into the website, the MCP server, and
// the n8n node. See types.ts.

// Accepted raster input MIME types: JPG, PNG, WebP — the three common web
// rasters every Canvas tool below can decode and re-encode losslessly-of-format.
export const RASTER_IMAGE_ACCEPT = ["image/jpeg", "image/png", "image/webp"] as const;

// Map an accepted raster input MIME to the file extension it saves under
// (JPEG re-encodes as .jpg).
export const RASTER_MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
