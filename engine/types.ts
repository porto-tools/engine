// The engine API contract — the architectural spine every conversion conforms to.
//
// This file (and everything else under src/engine/) imports ONLY itself and
// node_modules. It never reaches into app/, components/, or lib/. That firewall
// is what makes the eventual extraction to a published @porto-tools/engine
// package a mechanical move rather than a rewrite. See ARCHITECTURE.md.

export interface ConversionProgress {
  ratio?: number; // 0..1 ONLY when a real denominator exists; omit when indeterminate/instant
  stage?: string; // human label, e.g. "Encoding"
}

export interface ConversionInput {
  file: File;
  // Many-in inputs (e.g. PDF Merge). Optional and additive: when set, `file` is
  // files[0] so single-input converters keep reading `file` exactly as today.
  files?: File[];
  options?: Record<string, unknown>; // conversion-specific; PNG→JPG uses { quality, background }
  signal?: AbortSignal; // cancellation
  onProgress?: (p: ConversionProgress) => void;
}

// One file in a many-out result (e.g. PDF Split / PDF→images). A self-contained
// downloadable: the UI makes an object URL per entry and offers a zip of all.
export interface ConversionOutput {
  blob: Blob;
  filename: string;
  mimeType: string;
  size: number; // bytes
}

export interface ConversionResult {
  blob: Blob;
  filename: string; // original basename + new extension (see filename rule)
  mimeType: string;
  inputSize: number; // bytes
  outputSize: number; // bytes
  // Many-out results. Optional and additive: absent for every one-out converter,
  // so 100% of existing code sees `undefined` and renders the single ResultCard.
  // When present, the UI renders the multi-output view (per-file links + zip).
  outputs?: ConversionOutput[];
}

export class ConversionError extends Error {
  // The canonical taxonomy the codebase uses. Kept as a plain `string` (not a
  // union) so this contract stays open for future codes, but these are the ones
  // in use today:
  //   UNSUPPORTED_INPUT  — wrong/unrecognised input format (non-recoverable)
  //   DECODE_FAILED      — input couldn't be parsed/decoded (damaged/empty)
  //   ENCODE_FAILED      — producing the output (e.g. canvas.toBlob) failed
  //   ENGINE_LOAD_FAILED — a lazy WASM/library load failed (recoverable)
  //   CANVAS_UNAVAILABLE — couldn't obtain a 2D canvas context
  //   INFERENCE_FAILED   — an ML/model inference step failed
  //   CANCELLED          — the caller aborted via AbortSignal (recoverable)
  code: string;
  recoverable: boolean; // true → UI offers retry; false → UI says "try a different file"
  technical?: string; // raw detail shown behind "Show technical details"
  constructor(message: string, opts: { code: string; recoverable: boolean; technical?: string }) {
    super(message);
    this.name = "ConversionError";
    this.code = opts.code;
    this.recoverable = opts.recoverable;
    this.technical = opts.technical;
  }
}

export type Convert = (input: ConversionInput) => Promise<ConversionResult>;

// ── Interactive controls ────────────────────────────────────────────────────
//
// The descriptor-level schema for a tool's parameters (quality, dimensions, page
// range…). A descriptor with `controls` is button-driven: the UI stages the
// file, renders these controls, and runs `convert` only when the user clicks —
// passing the control values as `options`. Omitting `controls` keeps today's
// auto-on-drop behavior. This is a pure data contract: the engine declares WHAT
// a control is; the (engine-free) ControlPanel decides how to render it.
//
// Every control shares { id; label; help? }. `id` is the option key the control
// writes into `options` (composite controls fan out to several keys — see
// DimensionsControl). `type` is the discriminant.

interface ControlBase {
  id: string; // the option key this control writes (see composite note below)
  label: string; // visible field label
  help?: string; // optional helper text, wired via aria-describedby
}

// A bounded number entered in a text-style field. min/max/step/unit are all
// optional — an unbounded count, a stepped integer, etc.
export interface NumberControl extends ControlBase {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string; // e.g. "px", "%", shown alongside the field
}

// A bounded number on a slider. min/max are required (a range needs both ends);
// step defaults to 1 at the UI layer when omitted.
export interface RangeControl extends ControlBase {
  type: "range";
  default: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

// A DISCRETE draggable slider (YouTube/volume style) over a fixed list of `stops`.
// The thumb snaps to the nearest stop; the emitted value is that numeric stop.
// `anchor` marks one stop as a labelled neutral notch (e.g. 1× for playback speed).
export interface SliderControl extends ControlBase {
  type: "slider";
  default: number;
  stops: number[];
  unit?: string; // suffix shown with the value, e.g. "×"
  anchor?: number; // one stop drawn as a labelled neutral notch
}

// One choice from a fixed list. Rendered as a native <select> by default; with
// `variant: "buttons"` it renders as an icon button group, and `previewTransform`
// shows the staged image with the choice applied live (rotate/flip). `icon` names
// an inline glyph the button variant draws. The extras are optional — a plain
// select ignores them.
export interface SelectControl extends ControlBase {
  type: "select";
  default: string;
  options: { value: string; label: string; icon?: string }[];
  variant?: "buttons";
  previewTransform?: "rotate" | "flip";
}

// Free text (e.g. a filename stem, a watermark string).
export interface TextControl extends ControlBase {
  type: "text";
  default: string;
  placeholder?: string;
  maxLength?: number;
}

// A boolean toggle.
export interface CheckboxControl extends ControlBase {
  type: "checkbox";
  default: boolean;
}

// COMPOSITE: a width/height pair with an aspect-ratio lock. It does NOT write a
// single option key — it fans out to three flat keys so converters read plain
// numbers/booleans, never a nested object: `${id}Width`, `${id}Height`,
// `${id}KeepAspect`. Example: id "size" → options.sizeWidth, options.sizeHeight,
// options.sizeKeepAspect.
export interface DimensionsControl extends ControlBase {
  type: "dimensions";
  default: { width: number; height: number; keepAspect: boolean };
  min?: number; // applied to both axes; UI clamps to this
  max?: number;
}

// A page-range string like "1-3,5,8-10". Stored raw under `id` (converters parse
// it against the real page count with the engine's parsePageRange). `allowAll`
// lets an empty string mean "every page".
export interface PageRangeControl extends ControlBase {
  type: "page-range";
  default: string;
  allowAll?: boolean;
}

// VISUAL/COMPOSITE: an interactive crop rectangle drawn over the staged image. It
// has no scalar `default` — the real defaults (the full image, in image pixels)
// are set by the control once the image's natural size is known. Like
// DimensionsControl it does NOT write a single option key; it fans out to FOUR
// flat keys of image-pixel integers so converters read plain numbers, never a
// nested object: `${id}X`, `${id}Y`, `${id}W`, `${id}H`. Example: id "crop" →
// options.cropX, options.cropY, options.cropW, options.cropH. The control needs
// the staged file's preview to render, which the panel passes through; every
// non-visual control ignores it.
export interface CropControl extends ControlBase {
  type: "crop";
}

// VISUAL/COMPOSITE: an interactive trim timeline scrubbed over the staged video.
// Like CropControl it has no scalar `default` — the real defaults (start 0, end =
// the full duration, in seconds) are set by the control once the video's duration
// is known. It does NOT write a single option key; it fans out to TWO flat keys
// of seconds (numbers) so converters read plain numbers, never a nested object:
// `${id}Start`, `${id}End`. Example: id "trim" → options.trimStart,
// options.trimEnd. The control needs the staged file's preview to render the
// <video> it scrubs, which the panel passes through; every non-visual control
// ignores it.
export interface TimeRangeControl extends ControlBase {
  type: "time-range";
}

// A rotation angle in degrees. Rendered as two 90° quick-rotate buttons (left /
// right) plus a small numeric stepper the user can type into directly, with a
// live preview of the staged image rotated by the current value. Writes ONE
// numeric key (the angle in degrees) under `id`; the converter rotates by it.
// Example: id "angle" → options.angle (a number).
export interface AngleControl extends ControlBase {
  type: "angle";
  default: number; // degrees; 0 = unchanged
  step?: number; // stepper increment (UI defaults to 1 when omitted)
  min?: number; // optional clamp
  max?: number; // optional clamp
  unit?: string; // e.g. "°"
}

// A group of INDEPENDENT boolean toggles (e.g. Flip horizontal / Flip vertical —
// both can be on at once, each click toggles its own axis). Like the other
// composites it does NOT write a single key; each toggle fans out to a flat
// boolean key `${id}${toggle.id}`. Example: id "flip" with toggles
// [{id:"Horizontal"},{id:"Vertical"}] → options.flipHorizontal,
// options.flipVertical. `previewTransform: "flip"` shows the staged image with
// both active axes applied live.
export interface ToggleGroupControl extends ControlBase {
  type: "toggle-group";
  toggles: { id: string; label: string; icon?: string }[];
  previewTransform?: "flip";
}

// A file picker (e.g. a logo/image to stamp as a watermark). UNLIKE every other
// control, a File is NOT a primitive and cannot travel through the flat
// ControlValues bag (Record<string, string|number|boolean>) the panel is
// controlled by. Instead the value lives in a SEPARATE `fileValues:
// Record<string, File|null>` state in ControlsInputTool, and the panel reaches it
// via a dedicated `onFileChange(id, file)` callback (not `onChange`). At convert
// time the tool merges fileValues into `options` alongside the primitive values,
// so the converter reads the picked File under `options[id]` (the options
// pipeline is typed Record<string, unknown> and never serialized, so a File
// passes through intact). `accept` is the list of MIME types the input filters to
// (e.g. ["image/png","image/jpeg"]); seeding writes NOTHING to ControlValues.
export interface FileControl extends ControlBase {
  type: "file";
  accept: string[];
}

// The discriminated union the UI switches on. New control kinds are added here
// and given a render branch in ControlPanel — nowhere else.
export type ControlSchema =
  | NumberControl
  | RangeControl
  | SliderControl
  | SelectControl
  | TextControl
  | CheckboxControl
  | DimensionsControl
  | PageRangeControl
  | CropControl
  | TimeRangeControl
  | AngleControl
  | ToggleGroupControl
  | FileControl;

export interface ConversionDescriptor {
  id: string; // "png-to-jpg"
  fromLabel: string; // "PNG"
  toLabel: string; // "JPG"
  accept: string[]; // MIME types accepted, e.g. ["image/png"]
  newExtension: string; // "jpg"
  defaultOptions?: Record<string, unknown>;
  // Interactive parameters. Omitting `controls` = auto-on-drop as today (the
  // file converts the instant it's added, with `defaultOptions`). When present,
  // the tool becomes button-driven: the UI stages the file, renders these
  // controls (one file at a time), and runs `convert` on click with the control
  // values merged over `defaultOptions`. Strictly additive — every existing
  // descriptor omits it and is unaffected.
  controls?: ControlSchema[];
  // Input shape. Default "single" by absence = today's behavior (each dropped
  // file auto-converts on its own). "multi" (e.g. Merge) stages files and
  // converts once with `{ file: files[0], files }`. "multi-compress" stages MANY
  // files at once, each carrying its own control values, and converts them
  // independently (the compress tools — see MultiCompressTool).
  inputMode?: "single" | "multi" | "multi-compress";
  // Minimum staged files a "multi" input needs before its single run can fire —
  // gates StagingList's submit and MultiInputTool's convert guard. Only
  // meaningful for inputMode "multi"; absent ⇒ 2 (a merge needs at least two).
  // images-to-pdf sets it to 1 because a single image is a valid one-page PDF.
  minInputs?: number;
  // Output shape. Default "single" by absence = one ResultCard. "multi" (e.g.
  // Split / PDF→images) returns `outputs[]` and renders MultiResultCard.
  outputMode?: "single" | "multi";
  loadEngine?: () => Promise<void>; // lazy WASM load; OMIT for Canvas (no download needed)
  // Human-readable size of the one-time engine download, shown in the labelled
  // "Setting up the converter, ≈ X MB — one-time download" first-load state (see
  // CONVERSION-RECIPE.md §9). Optional and additive: when absent the setup line
  // omits the size. Only meaningful alongside loadEngine; ignored without it.
  setupSizeLabel?: string;
  convert: Convert;
}
