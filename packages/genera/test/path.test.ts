import { describe, expect, it } from "vitest";
import { basename, joinPath, normalizePath, parentPath } from "../src/index";

describe("normalizePath", () => {
  it("strips leading slashes and collapses redundant segments", () => {
    expect(normalizePath("/a//b/./c")).toBe("a/b/c");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("a\\b\\c")).toBe("a/b/c");
  });

  it("normalizes the empty/root path to an empty string", () => {
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("")).toBe("");
  });

  it("rejects parent-directory traversal", () => {
    expect(() => normalizePath("a/../b")).toThrow(/traversal/);
  });

  it("rejects null bytes", () => {
    expect(() => normalizePath("a\0b")).toThrow();
  });
});

describe("path helpers", () => {
  it("basename returns the last segment", () => {
    expect(basename("a/b/c.txt")).toBe("c.txt");
    expect(basename("solo.txt")).toBe("solo.txt");
  });

  it("parentPath returns everything but the last segment", () => {
    expect(parentPath("a/b/c.txt")).toBe("a/b");
    expect(parentPath("solo.txt")).toBe("");
  });

  it("joinPath joins and normalizes", () => {
    expect(joinPath("a/", "/b", "c")).toBe("a/b/c");
  });
});
