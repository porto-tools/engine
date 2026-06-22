// pdf-editor-bake is pure JavaScript (pdf-lib only) — every test runs for real
// in Node with no skip-guard. We assert two things: the coordinate maths are
// exact (the headline fraction↔PDF-point + y-flip + px→pt contract), and the
// draw walk emits the right pdf-lib calls at the expected coordinates by spying
// on a real PDFPage's draw methods.

import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fractionToPdfBox,
  fractionPointToPdf,
  fractionToPdfRect,
  fractionToQuadPoints,
  pxToPt,
  pointsToSvgPath,
  bakeAnnotations,
  pdfEditorDescriptor,
  type PageAnnots,
} from "./pdf-editor-bake";

// A4 in PDF points.
const A4_W = 595;
const A4_H = 842;

const BLACK = { r: 0, g: 0, b: 0 };
const RED = { r: 1, g: 0, b: 0 };

const HERE = dirname(fileURLToPath(import.meta.url));
// Reuse the shared tiny single-page PDF fixture (also used by flatten-pdf).
async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(join(HERE, "__fixtures__", "flatten-pdf", name));
  return new File([bytes], name, { type: "application/pdf" });
}

describe("pdf-editor-bake coordinate maths", () => {
  it("maps a fractional box to a bottom-left PDF box with the y-flip", () => {
    // A box at the top-left quarter: top-left origin {x:0, y:0, w:0.5, h:0.5}.
    // Its PDF bottom-left corner is x=0, y=(1-0-0.5)*H = 0.5*H.
    expect(fractionToPdfBox(0, 0, 0.5, 0.5, A4_W, A4_H)).toEqual({
      x: 0,
      y: 0.5 * A4_H,
      width: 0.5 * A4_W,
      height: 0.5 * A4_H,
    });
  });

  it("maps a full-page box {0,0,1,1} to the whole page at the origin", () => {
    expect(fractionToPdfBox(0, 0, 1, 1, A4_W, A4_H)).toEqual({
      x: 0,
      y: 0,
      width: A4_W,
      height: A4_H,
    });
  });

  it("maps a single point with the y-flip (top-left origin → bottom-left)", () => {
    // Top edge fy=0 → PDF y = H; bottom edge fy=1 → PDF y = 0.
    expect(fractionPointToPdf(0.5, 0, A4_W, A4_H)).toEqual({ x: 0.5 * A4_W, y: A4_H });
    expect(fractionPointToPdf(0.5, 1, A4_W, A4_H)).toEqual({ x: 0.5 * A4_W, y: 0 });
  });

  it("converts CSS px to PDF points (96→72 DPI)", () => {
    expect(pxToPt(96)).toBe(72);
    expect(pxToPt(16)).toBeCloseTo(12, 10);
  });

  it("maps a fractional box to a PDF /Rect [llx,lly,urx,ury]", () => {
    // Box {0.1,0.2,0.3,0.25}: bottom-left x=0.1*W, y=(1-0.2-0.25)*H; top-right
    // adds the box width/height.
    const [llx, lly, urx, ury] = fractionToPdfRect(0.1, 0.2, 0.3, 0.25, A4_W, A4_H);
    expect(llx).toBeCloseTo(0.1 * A4_W, 6);
    expect(lly).toBeCloseTo((1 - 0.2 - 0.25) * A4_H, 6);
    expect(urx).toBeCloseTo(0.4 * A4_W, 6);
    expect(ury).toBeCloseTo((1 - 0.2) * A4_H, 6);
  });

  it("maps a fractional box to 8 /QuadPoints in UL,UR,LL,LR order", () => {
    // Same box as the /Rect test. The quad corners are derived from the rect:
    // UL=(llx,ury), UR=(urx,ury), LL=(llx,lly), LR=(urx,lly).
    const quad = fractionToQuadPoints(0.1, 0.2, 0.3, 0.25, A4_W, A4_H);
    const llx = 0.1 * A4_W;
    const urx = 0.4 * A4_W;
    const lly = (1 - 0.2 - 0.25) * A4_H;
    const ury = (1 - 0.2) * A4_H;
    expect(quad).toHaveLength(8);
    expect(quad[0]).toBeCloseTo(llx, 6); // UL.x
    expect(quad[1]).toBeCloseTo(ury, 6); // UL.y
    expect(quad[2]).toBeCloseTo(urx, 6); // UR.x
    expect(quad[3]).toBeCloseTo(ury, 6); // UR.y
    expect(quad[4]).toBeCloseTo(llx, 6); // LL.x
    expect(quad[5]).toBeCloseTo(lly, 6); // LL.y
    expect(quad[6]).toBeCloseTo(urx, 6); // LR.x
    expect(quad[7]).toBeCloseTo(lly, 6); // LR.y
  });
});

describe("pointsToSvgPath", () => {
  it("returns an empty string for fewer than two points (caller skips drawing)", () => {
    expect(pointsToSvgPath([], A4_W, A4_H)).toBe("");
    expect(pointsToSvgPath([{ x: 0.5, y: 0.5 }], A4_W, A4_H)).toBe("");
  });

  it("encodes fractional points into a PDF-point M/L path (top-left, y-down)", () => {
    // Points map to PDF points by px = fx*W, py = fy*H (drawSvgPath flips y).
    const path = pointsToSvgPath(
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.25 },
        { x: 1, y: 1 },
      ],
      A4_W,
      A4_H,
    );
    expect(path).toBe(`M 0,0 L ${0.5 * A4_W},${0.25 * A4_H} L ${A4_W},${A4_H}`);
  });
});

describe("bakeAnnotations draw calls", () => {
  // Spin up a real one-page A4 document and spy on the page's draw methods, so
  // the test asserts the exact coordinates the walk emits.
  async function bakeOnA4(objects: PageAnnots["objects"]) {
    const lib = await import("pdf-lib");
    const doc = await lib.PDFDocument.create();
    doc.addPage([A4_W, A4_H]);
    const page = doc.getPages()[0];

    const drawText = vi.spyOn(page, "drawText");
    const drawRectangle = vi.spyOn(page, "drawRectangle");
    const drawEllipse = vi.spyOn(page, "drawEllipse");
    const drawLine = vi.spyOn(page, "drawLine");
    const drawImage = vi.spyOn(page, "drawImage");
    const drawSvgPath = vi.spyOn(page, "drawSvgPath");

    await bakeAnnotations(doc, lib, [{ page: 1, objects }]);
    return { drawText, drawRectangle, drawEllipse, drawLine, drawImage, drawSvgPath };
  }

  // A 1×1 transparent PNG (the canonical tiny PNG) as a base64 dataURL, so
  // embedPng has real bytes to parse without a fixture file.
  const PNG_1X1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("draws text centred at fraction {0.5,0.5} at the expected baseline", async () => {
    const { drawText } = await bakeOnA4([
      {
        type: "text",
        x: 0.5,
        y: 0.5,
        w: 0.2,
        h: 0.05,
        opacity: 1,
        text: "Hello",
        fontSize: 16,
        color: BLACK,
        bold: false,
        italic: false,
      },
    ]);
    expect(drawText).toHaveBeenCalledTimes(1);
    const [text, opts] = drawText.mock.calls[0]!;
    if (!opts) throw new Error("no opts");
    expect(text).toBe("Hello");
    // x = fx*W = 0.5*595. baseline = (1 - 0.5 - 0.05)*842 + size*0.2.
    const size = pxToPt(16);
    expect(opts.x).toBeCloseTo(0.5 * A4_W, 6);
    expect(opts.y).toBeCloseTo((1 - 0.5 - 0.05) * A4_H + size * 0.2, 6);
    expect(opts.size).toBeCloseTo(size, 6);
  });

  it("draws a full-page rect for {0,0,1,1}", async () => {
    const { drawRectangle } = await bakeOnA4([
      {
        type: "rect",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        opacity: 1,
        fillColor: null,
        borderColor: RED,
        borderWidth: 2,
      },
    ]);
    expect(drawRectangle).toHaveBeenCalledTimes(1);
    const [opts] = drawRectangle.mock.calls[0]!;
    if (!opts) throw new Error("no opts");
    expect(opts.x).toBe(0);
    expect(opts.y).toBe(0);
    expect(opts.width).toBe(A4_W);
    expect(opts.height).toBe(A4_H);
    expect(opts.borderWidth).toBeCloseTo(pxToPt(2), 6);
  });

  it("draws an ellipse at the box centre with half-width/height radii", async () => {
    const { drawEllipse } = await bakeOnA4([
      {
        type: "ellipse",
        x: 0.25,
        y: 0.25,
        w: 0.5,
        h: 0.5,
        opacity: 1,
        fillColor: null,
        borderColor: BLACK,
        borderWidth: 1,
      },
    ]);
    const [opts] = drawEllipse.mock.calls[0]!;
    if (!opts) throw new Error("no opts");
    // box: x=0.25*W, y=(1-0.25-0.5)*H=0.25*H, w=0.5*W, h=0.5*H.
    // centre = box.x + box.w/2 = 0.5*W ; box.y + box.h/2 = 0.5*H.
    expect(opts.x).toBeCloseTo(0.5 * A4_W, 6);
    expect(opts.y).toBeCloseTo(0.5 * A4_H, 6);
    expect(opts.xScale).toBeCloseTo(0.25 * A4_W, 6);
    expect(opts.yScale).toBeCloseTo(0.25 * A4_H, 6);
  });

  it("draws a line between its two y-flipped endpoints", async () => {
    const { drawLine } = await bakeOnA4([
      {
        type: "line",
        x: 0.1,
        y: 0.1,
        w: 0.8,
        h: 0.8,
        opacity: 1,
        x1: 0.1,
        y1: 0.1,
        x2: 0.9,
        y2: 0.9,
        color: BLACK,
        borderWidth: 3,
      },
    ]);
    const [opts] = drawLine.mock.calls[0]!;
    if (!opts) throw new Error("no opts");
    expect(opts.start.x).toBeCloseTo(0.1 * A4_W, 6);
    expect(opts.start.y).toBeCloseTo((1 - 0.1) * A4_H, 6);
    expect(opts.end.x).toBeCloseTo(0.9 * A4_W, 6);
    expect(opts.end.y).toBeCloseTo((1 - 0.9) * A4_H, 6);
    expect(opts.thickness).toBeCloseTo(pxToPt(3), 6);
  });

  it("draws a placed image at the fractional box, y-flipped, with opacity", async () => {
    const { drawImage } = await bakeOnA4([
      {
        type: "image",
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.25,
        opacity: 0.5,
        dataUrl: PNG_1X1,
        mimeType: "image/png",
      },
    ]);
    expect(drawImage).toHaveBeenCalledTimes(1);
    const [, opts] = drawImage.mock.calls[0]!;
    if (!opts) throw new Error("no opts");
    // box: x=0.1*W, y=(1-0.2-0.25)*H, w=0.3*W, h=0.25*H.
    expect(opts.x).toBeCloseTo(0.1 * A4_W, 6);
    expect(opts.y).toBeCloseTo((1 - 0.2 - 0.25) * A4_H, 6);
    expect(opts.width).toBeCloseTo(0.3 * A4_W, 6);
    expect(opts.height).toBeCloseTo(0.25 * A4_H, 6);
    expect(opts.opacity).toBe(0.5);
  });

  it("draws a pencil stroke as an SVG path at { x:0, y:H } with stroke style", async () => {
    const { drawSvgPath } = await bakeOnA4([
      {
        type: "pencil",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        opacity: 0.9,
        points: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 1 },
        ],
        strokeColor: RED,
        strokeWidth: 4,
      },
    ]);
    expect(drawSvgPath).toHaveBeenCalledTimes(1);
    const [path, opts] = drawSvgPath.mock.calls[0]!;
    if (!opts) throw new Error("no opts");
    expect(path).toBe(`M 0,0 L ${0.5 * A4_W},${0.5 * A4_H} L ${A4_W},${A4_H}`);
    // Origin at the page top-left in PDF space so the SVG y-down flips correctly.
    expect(opts.x).toBe(0);
    expect(opts.y).toBe(A4_H);
    expect(opts.borderWidth).toBeCloseTo(pxToPt(4), 6);
    expect(opts.borderOpacity).toBe(0.9);
  });

  it("skips a pencil stroke with fewer than two points (no draw call)", async () => {
    const { drawSvgPath } = await bakeOnA4([
      {
        type: "pencil",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        opacity: 1,
        points: [{ x: 0.5, y: 0.5 }],
        strokeColor: RED,
        strokeWidth: 2,
      },
    ]);
    expect(drawSvgPath).not.toHaveBeenCalled();
  });

  it("draws objects in array order (z-order = index, last on top)", async () => {
    const order: string[] = [];
    const lib = await import("pdf-lib");
    const doc = await lib.PDFDocument.create();
    doc.addPage([A4_W, A4_H]);
    const page = doc.getPages()[0];
    vi.spyOn(page, "drawRectangle").mockImplementation(() => order.push("rect"));
    vi.spyOn(page, "drawEllipse").mockImplementation(() => order.push("ellipse"));

    await bakeAnnotations(doc, lib, [
      {
        page: 1,
        objects: [
          { type: "rect", x: 0, y: 0, w: 1, h: 1, opacity: 1, fillColor: null, borderColor: BLACK, borderWidth: 1 },
          { type: "ellipse", x: 0, y: 0, w: 1, h: 1, opacity: 1, fillColor: null, borderColor: BLACK, borderWidth: 1 },
        ],
      },
    ]);
    expect(order).toEqual(["rect", "ellipse"]);
  });
});

describe("markup + link interactive annotations", () => {
  // Bake the given objects onto a fresh A4 page and return the page's /Annots
  // array (the spec-conformant annotation dicts), plus pdf-lib for name lookups.
  async function annotsAfterBake(objects: PageAnnots["objects"]) {
    const lib = await import("pdf-lib");
    const doc = await lib.PDFDocument.create();
    doc.addPage([A4_W, A4_H]);
    const page = doc.getPages()[0];
    await bakeAnnotations(doc, lib, [{ page: 1, objects }]);
    const annots = page.node.Annots();
    return { lib, page, annots };
  }

  it("adds a /Highlight /Annot with /QuadPoints, /C and /CA for a highlight", async () => {
    const { lib, annots } = await annotsAfterBake([
      { type: "highlight", x: 0.1, y: 0.2, w: 0.3, h: 0.25, opacity: 0.6, color: RED },
    ]);
    if (!annots) throw new Error("no /Annots array");
    expect(annots.size()).toBe(1);
    const dict = annots.lookup(0, lib.PDFDict);
    expect(dict.lookup(lib.PDFName.of("Subtype"), lib.PDFName)).toBe(lib.PDFName.of("Highlight"));
    // /QuadPoints holds 8 numbers; the first quad's UL.x = llx = 0.1*W.
    const quad = dict.lookup(lib.PDFName.of("QuadPoints"), lib.PDFArray);
    expect(quad.size()).toBe(8);
    expect((quad.lookup(0, lib.PDFNumber)).asNumber()).toBeCloseTo(0.1 * A4_W, 4);
    // /CA opacity round-trips.
    expect((dict.lookup(lib.PDFName.of("CA"), lib.PDFNumber)).asNumber()).toBeCloseTo(0.6, 6);
    // /C colour array carries the three channels (red = [1,0,0]).
    const c = dict.lookup(lib.PDFName.of("C"), lib.PDFArray);
    expect(c.size()).toBe(3);
    expect((c.lookup(0, lib.PDFNumber)).asNumber()).toBe(1);
  });

  it("uses /Underline and /StrikeOut subtypes for those markup kinds", async () => {
    const u = await annotsAfterBake([
      { type: "underline", x: 0.1, y: 0.1, w: 0.2, h: 0.05, opacity: 1, color: BLACK },
    ]);
    expect(u.annots!.lookup(0, u.lib.PDFDict).lookup(u.lib.PDFName.of("Subtype"), u.lib.PDFName)).toBe(
      u.lib.PDFName.of("Underline"),
    );
    const s = await annotsAfterBake([
      { type: "strikeout", x: 0.1, y: 0.1, w: 0.2, h: 0.05, opacity: 1, color: BLACK },
    ]);
    expect(s.annots!.lookup(0, s.lib.PDFDict).lookup(s.lib.PDFName.of("Subtype"), s.lib.PDFName)).toBe(
      s.lib.PDFName.of("StrikeOut"),
    );
  });

  it("adds a /Link /Annot with a /URI action carrying the href", async () => {
    const { lib, annots } = await annotsAfterBake([
      { type: "link", x: 0.1, y: 0.2, w: 0.3, h: 0.1, opacity: 1, href: "https://porto.tools/" },
    ]);
    if (!annots) throw new Error("no /Annots array");
    expect(annots.size()).toBe(1);
    const dict = annots.lookup(0, lib.PDFDict);
    expect(dict.lookup(lib.PDFName.of("Subtype"), lib.PDFName)).toBe(lib.PDFName.of("Link"));
    // /Rect is the 4-number rectangle (llx = 0.1*W).
    const rect = dict.lookup(lib.PDFName.of("Rect"), lib.PDFArray);
    expect(rect.size()).toBe(4);
    expect((rect.lookup(0, lib.PDFNumber)).asNumber()).toBeCloseTo(0.1 * A4_W, 4);
    // The /A action is a /URI action whose /URI string is the href.
    const action = dict.lookup(lib.PDFName.of("A"), lib.PDFDict);
    expect(action.lookup(lib.PDFName.of("S"), lib.PDFName)).toBe(lib.PDFName.of("URI"));
    expect((action.lookup(lib.PDFName.of("URI"), lib.PDFString)).asString()).toBe("https://porto.tools/");
  });

  it("skips a link with an empty href (no annotation added)", async () => {
    const { annots } = await annotsAfterBake([
      { type: "link", x: 0.1, y: 0.2, w: 0.3, h: 0.1, opacity: 1, href: "" },
    ]);
    // No /Annots array is created when nothing was added.
    expect(annots === undefined || annots.size() === 0).toBe(true);
  });
});

describe("pdfEditorDescriptor.convert", () => {
  it("bakes annotations into a valid PDF and keeps the page count", async () => {
    const file = await fileFromFixture("tiny.pdf");
    const annotations: PageAnnots[] = [
      {
        page: 1,
        objects: [
          { type: "rect", x: 0.1, y: 0.1, w: 0.3, h: 0.2, opacity: 0.8, fillColor: RED, borderColor: BLACK, borderWidth: 2 },
        ],
      },
    ];
    const result = await pdfEditorDescriptor.convert({ file, options: { annotations } });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("tiny.pdf");
    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...outBytes.slice(0, 4))).toBe("%PDF");

    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(outBytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("re-saves unchanged when there are no annotations", async () => {
    const file = await fileFromFixture("tiny.pdf");
    const result = await pdfEditorDescriptor.convert({ file, options: {} });
    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...outBytes.slice(0, 4))).toBe("%PDF");
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(pdfEditorDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });
});
