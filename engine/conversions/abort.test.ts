import { describe, it, expect, vi } from "vitest";
import { throwIfAborted } from "./abort";

// throwIfAborted is pure control-flow (no DOM): it inspects an AbortSignal and
// throws the canonical CANCELLED ConversionError when aborted, optionally running
// a cleanup callback first. Full Node coverage, no canvas needed.

describe("throwIfAborted", () => {
  it("no-ops when the signal is undefined", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("no-ops when the signal is present but not aborted", () => {
    const ctrl = new AbortController();
    expect(() => throwIfAborted(ctrl.signal)).not.toThrow();
  });

  it("throws CANCELLED (recoverable) on an aborted signal", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() => throwIfAborted(ctrl.signal)).toThrowError(
      expect.objectContaining({ code: "CANCELLED", recoverable: true }),
    );
  });

  it("runs the cleanup callback before throwing when aborted", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const cleanup = vi.fn();
    expect(() => throwIfAborted(ctrl.signal, cleanup)).toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does NOT run cleanup when the signal is not aborted", () => {
    const ctrl = new AbortController();
    const cleanup = vi.fn();
    throwIfAborted(ctrl.signal, cleanup);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("does NOT run cleanup when the signal is undefined", () => {
    const cleanup = vi.fn();
    throwIfAborted(undefined, cleanup);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
