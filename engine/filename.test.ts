import { describe, it, expect } from "vitest";
import { replaceExtension } from "@/engine";

describe("replaceExtension", () => {
  it("swaps a simple extension", () => {
    expect(replaceExtension("vacation.png", "jpg")).toBe("vacation.jpg");
  });

  it("replaces only the last extension, keeping interior dots", () => {
    expect(replaceExtension("my.photo.png", "jpg")).toBe("my.photo.jpg");
  });

  it("appends an extension when the name has none", () => {
    expect(replaceExtension("noextension", "jpg")).toBe("noextension.jpg");
  });

  it("treats a leading-dot dotfile as having no extension to strip", () => {
    // The dot is at index 0, so lastIndexOf > 0 is false: keep ".env" whole.
    expect(replaceExtension(".env", "jpg")).toBe(".env.jpg");
  });

  it("handles an empty filename (documents current behavior)", () => {
    // No dot found, base stays empty, so the result is just the new extension.
    expect(replaceExtension("", "jpg")).toBe(".jpg");
  });
});
