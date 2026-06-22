// Tests for csv-json.ts. Unlike canvas/WASM conversions, this is pure JS —
// happy-path tests run in Node without any skip-guard. All four categories
// (happy path, UNSUPPORTED_INPUT, DECODE_FAILED, CANCELLED) execute for real.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { csvJsonDescriptor, jsonCsvDescriptor } from "./csv-json";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "csv-json", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// ─── CSV → JSON ─────────────────────────────────────────────────────────────

describe("csvJsonDescriptor", () => {
  it("converts a CSV file to JSON (happy path)", async () => {
    const file = await fileFromFixture("sample.csv", "text/csv");
    const result = await csvJsonDescriptor.convert({ file });

    expect(result.mimeType).toBe("application/json");
    expect(result.filename).toBe("sample.json");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);

    // Verify the content is valid JSON with the expected shape.
    const text = await result.blob.text();
    const rows = JSON.parse(text) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(3);
    expect((rows[0] as Record<string, string>).name).toBe("Alice");
  });

  it("preserves string fidelity (no dynamic typing)", async () => {
    // A leading-zero value like "007" must stay "007", not become 7.
    const csv = "id,code\n1,007\n2,042\n";
    const file = new File([csv], "codes.csv", { type: "text/csv" });
    const result = await csvJsonDescriptor.convert({ file });
    const text = await result.blob.text();
    const rows = JSON.parse(text) as Array<Record<string, string>>;
    expect(rows[0].code).toBe("007");
    expect(rows[1].code).toBe("042");
  });

  it("rejects a non-CSV MIME as UNSUPPORTED_INPUT", async () => {
    const file = new File(["<html>"], "page.html", { type: "text/html" });
    await expect(csvJsonDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects malformed/empty CSV as DECODE_FAILED", async () => {
    // A file with only a header row and no data rows.
    const file = new File(["name,age,city\n"], "empty.csv", { type: "text/csv" });
    await expect(csvJsonDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("sample.csv", "text/csv");
    await expect(csvJsonDescriptor.convert({ file, signal: ctrl.signal })).rejects.toMatchObject({
      code: "CANCELLED",
      recoverable: true,
    });
  });
});

// ─── JSON → CSV ─────────────────────────────────────────────────────────────

describe("jsonCsvDescriptor", () => {
  it("converts a JSON file to CSV (happy path)", async () => {
    const file = await fileFromFixture("sample.json", "application/json");
    const result = await jsonCsvDescriptor.convert({ file });

    expect(result.mimeType).toBe("text/csv");
    expect(result.filename).toBe("sample.csv");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);

    // Verify the CSV has a header row and 3 data rows.
    const text = await result.blob.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(4); // header + 3 rows
    expect(lines[0]).toContain("name");
    expect(lines[1]).toContain("Alice");
  });

  it("rejects JSON that is not an array as UNSUPPORTED_INPUT", async () => {
    const file = new File(['{"name": "Alice"}'], "obj.json", { type: "application/json" });
    await expect(jsonCsvDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an array of non-objects (array-of-scalars) as UNSUPPORTED_INPUT", async () => {
    const file = new File(["[1, 2, 3]"], "scalars.json", { type: "application/json" });
    await expect(jsonCsvDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty JSON array as UNSUPPORTED_INPUT", async () => {
    const file = new File(["[]"], "empty.json", { type: "application/json" });
    await expect(jsonCsvDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects malformed JSON as DECODE_FAILED", async () => {
    const file = new File(["{not json at all"], "broken.json", { type: "application/json" });
    await expect(jsonCsvDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("rejects a non-JSON MIME as UNSUPPORTED_INPUT", async () => {
    const file = new File(["hello"], "text.txt", { type: "text/plain" });
    await expect(jsonCsvDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("sample.json", "application/json");
    await expect(jsonCsvDescriptor.convert({ file, signal: ctrl.signal })).rejects.toMatchObject({
      code: "CANCELLED",
      recoverable: true,
    });
  });
});

// ─── Round-trip: CSV → JSON → CSV ────────────────────────────────────────────

describe("round-trip CSV → JSON → CSV", () => {
  it("round-trips flat data without loss", async () => {
    const original = await fileFromFixture("sample.csv", "text/csv");

    // Step 1: CSV → JSON
    const jsonResult = await csvJsonDescriptor.convert({ file: original });
    const jsonFile = new File([jsonResult.blob], "sample.json", {
      type: "application/json",
    });

    // Step 2: JSON → CSV
    const csvResult = await jsonCsvDescriptor.convert({ file: jsonFile });
    const csvText = await csvResult.blob.text();

    // The round-tripped CSV must contain the same values (header + data).
    expect(csvText).toContain("name");
    expect(csvText).toContain("Alice");
    expect(csvText).toContain("Bob");
    expect(csvText).toContain("Carol");
    expect(csvText).toContain("New York");
    expect(csvText).toContain("London");
    expect(csvText).toContain("Tokyo");
  });
});
