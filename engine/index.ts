// Public surface of the engine. App and component code import from here, never
// from individual files inside src/engine/. When the engine is extracted to
// @porto-tools/engine, this becomes the package entry point unchanged.
//
// This barrel is the future @porto-tools/engine public surface. Types and
// utilities such as ConversionProgress, ConversionInput, Convert,
// ConversionError, and replaceExtension are exported here for downstream
// consumers even when no in-repo file imports them yet — they are kept
// intentionally and must not be removed.

export type {
  ConversionProgress,
  ConversionInput,
  ConversionOutput,
  ConversionResult,
  Convert,
  ConversionDescriptor,
  ControlSchema,
  NumberControl,
  RangeControl,
  SelectControl,
  TextControl,
  CheckboxControl,
  DimensionsControl,
  PageRangeControl,
  CropControl,
  TimeRangeControl,
  AngleControl,
  ToggleGroupControl,
} from "./types";
export { ConversionError } from "./types";
export { replaceExtension } from "./filename";
export { parsePageRange } from "./page-range";
export { pngToJpgDescriptor, jpgToPngDescriptor } from "./conversions/png-jpg";
export { imageConverterDescriptor } from "./conversions/image-converter";
export { imageResizeDescriptor } from "./conversions/image-resize";
export { imageUpscaleDescriptor } from "./conversions/image-upscale";
export { svgPngDescriptor } from "./conversions/svg-png";
export { webpPngDescriptor, pngWebpDescriptor } from "./conversions/webp-png";
export { webpJpgDescriptor, jpgWebpDescriptor } from "./conversions/webp-jpg";
export { pngSvgDescriptor } from "./conversions/png-svg";
export { heicJpgDescriptor } from "./conversions/heic-jpg";
export { extractZipDescriptor } from "./conversions/extract-zip";
export { csvJsonDescriptor, jsonCsvDescriptor } from "./conversions/csv-json";
export { createZipDescriptor } from "./conversions/create-zip";
export { pdfToJpgDescriptor, pdfToPngDescriptor } from "./conversions/pdf-image";
export { pdfSplitDescriptor } from "./conversions/pdf-split";
export { comparePdfDescriptor } from "./conversions/compare-pdf";
export { pdfMergeDescriptor } from "./conversions/pdf-merge";
export { gzipDescriptor } from "./conversions/gzip";
export { mp3WavDescriptor } from "./conversions/mp3-wav";
export { createTarDescriptor } from "./conversions/create-tar";
export { wavMp3Descriptor } from "./conversions/wav-mp3";
export { mp3M4aDescriptor } from "./conversions/mp3-m4a";
export { m4aMp3Descriptor } from "./conversions/m4a-mp3";
export { flacMp3Descriptor } from "./conversions/flac-mp3";
export { oggMp3Descriptor } from "./conversions/ogg-mp3";
export { mp4GifDescriptor } from "./conversions/mp4-gif";
export { gifMp4Descriptor } from "./conversions/gif-mp4";
export { mp4WebmDescriptor } from "./conversions/mp4-webm";
export { webmMp4Descriptor } from "./conversions/webm-mp4";
export { videoTrimDescriptor } from "./conversions/video-trim";
export { videoCropDescriptor } from "./conversions/video-crop";
export { videoSpeedDescriptor } from "./conversions/video-speed";
export { extractAudioDescriptor } from "./conversions/extract-audio";
export { audioConverterDescriptor } from "./conversions/audio-converter";
export { muteVideoDescriptor } from "./conversions/mute-video";
export { reverseVideoDescriptor } from "./conversions/reverse-video";
export { removeVocalsDescriptor } from "./conversions/remove-vocals";
export { flipVideoDescriptor } from "./conversions/flip-video";
export { imageCropDescriptor } from "./conversions/image-crop";
export { imageRotateDescriptor } from "./conversions/image-rotate";
export { imageFlipDescriptor } from "./conversions/image-flip";
export { imageToIcoDescriptor } from "./conversions/image-to-ico";
export { imagesToPdfDescriptor } from "./conversions/images-to-pdf";
export { htmlToPdfDescriptor } from "./conversions/html-to-pdf";
export { epubToPdfDescriptor } from "./conversions/epub-pdf";
export { rotatePdfPagesDescriptor } from "./conversions/rotate-pdf-pages";
export { deletePdfPagesDescriptor } from "./conversions/delete-pdf-pages";
export { reorderPdfPagesDescriptor } from "./conversions/reorder-pdf-pages";
export { flattenPdfDescriptor } from "./conversions/flatten-pdf";
export { pdfToPdfaDescriptor } from "./conversions/pdf-to-pdfa";
export { pageNumbersPdfDescriptor } from "./conversions/page-numbers-pdf";
export { watermarkPdfDescriptor } from "./conversions/watermark-pdf";
export { signPdfDescriptor } from "./conversions/sign-pdf";
export { cropPdfDescriptor } from "./conversions/crop-pdf";
export { protectPdfDescriptor } from "./conversions/protect-pdf";
export { unlockPdfDescriptor } from "./conversions/unlock-pdf";
export { redactPdfDescriptor } from "./conversions/redact-pdf";
export { extractPdfImagesDescriptor } from "./conversions/extract-pdf-images";
export { pdfToTextDescriptor } from "./conversions/pdf-to-text";
export { pdfEditorDescriptor } from "./conversions/pdf-editor-bake";
export type {
  AnnotColor,
  AnnotObject,
  TextAnnot,
  RectAnnot,
  EllipseAnnot,
  LineAnnot,
  ImageAnnot,
  PencilAnnot,
  MarkupAnnot,
  LinkAnnot,
  PageAnnots,
} from "./conversions/pdf-editor-bake";
export { compressImageDescriptor } from "./conversions/compress-image";
export { compressGifDescriptor } from "./conversions/compress-gif";
export { compressVideoDescriptor } from "./conversions/compress-video";
export { compressPdfDescriptor } from "./conversions/compress-pdf";
export { removeBackgroundDescriptor } from "./conversions/remove-background";
export { repairPdfDescriptor } from "./conversions/repair-pdf";
