import { beforeEach, describe, expect, it } from "vitest";

import { PathResolver, type PathResolverAdapter, type ResolverNode } from "../src/index";

/** An in-memory tree backing the resolver — stands in for Drive/Box. */
class FakeTree implements PathResolverAdapter {
  readonly rootId = "root";
  private readonly nodes = new Map<
    string,
    { name: string; parentId: string; type: "file" | "directory" }
  >();
  private seq = 0;
  listCalls = 0;
  createCalls = 0;

  add(parentId: string, name: string, type: "file" | "directory"): string {
    const id = `n${++this.seq}`;
    this.nodes.set(id, { name, parentId, type });
    return id;
  }

  listChildren(parentId: string, name: string): Promise<ResolverNode[]> {
    this.listCalls++;
    const out: ResolverNode[] = [];
    for (const [id, node] of this.nodes) {
      if (node.parentId === parentId && node.name === name) out.push({ id, type: node.type });
    }
    return Promise.resolve(out);
  }

  createFolder(parentId: string, name: string): Promise<string> {
    this.createCalls++;
    return Promise.resolve(this.add(parentId, name, "directory"));
  }
}

describe("PathResolver", () => {
  let tree: FakeTree;
  let resolver: PathResolver;
  let docsId: string;
  let subId: string;
  let readmeId: string;

  beforeEach(() => {
    tree = new FakeTree();
    resolver = new PathResolver(tree);
    docsId = tree.add("root", "docs", "directory");
    readmeId = tree.add(docsId, "readme.txt", "file");
    subId = tree.add(docsId, "sub", "directory");
    tree.add(subId, "inner.txt", "file");
  });

  it("resolves the root to the adapter's rootId", async () => {
    expect(await resolver.resolve("")).toEqual({ id: "root", type: "directory" });
  });

  it("resolves a nested path to its node", async () => {
    expect(await resolver.resolve("docs/readme.txt")).toEqual({ id: readmeId, type: "file" });
    expect(await resolver.resolve("docs/sub")).toEqual({ id: subId, type: "directory" });
  });

  it("returns undefined for a missing segment", async () => {
    expect(await resolver.resolve("docs/nope.txt")).toBeUndefined();
    expect(await resolver.resolve("missing/deep.txt")).toBeUndefined();
  });

  it("returns undefined when descending through a file", async () => {
    expect(await resolver.resolve("docs/readme.txt/x")).toBeUndefined();
  });

  it("caches resolved prefixes (second lookup hits no adapter calls)", async () => {
    await resolver.resolve("docs/readme.txt");
    const callsAfterFirst = tree.listCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await resolver.resolve("docs/readme.txt");
    expect(tree.listCalls).toBe(callsAfterFirst); // fully cached
  });

  it("resolveDirectoryCreating creates missing folders once, then caches", async () => {
    const id = await resolver.resolveDirectoryCreating("a/b/c");
    expect(tree.createCalls).toBe(3);
    expect(await resolver.resolve("a/b/c")).toEqual({ id, type: "directory" });

    await resolver.resolveDirectoryCreating("a/b/c");
    expect(tree.createCalls).toBe(3); // no new folders created
  });

  it("resolveDirectoryCreating reuses existing folders", async () => {
    const id = await resolver.resolveDirectoryCreating("docs/sub");
    expect(id).toBe(subId);
    expect(tree.createCalls).toBe(0);
  });

  it("rejects creating a directory chain through a file", async () => {
    await expect(resolver.resolveDirectoryCreating("docs/readme.txt/x")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("invalidate drops the path and its descendants", async () => {
    await resolver.resolve("docs/sub/inner.txt");
    resolver.invalidate("docs");
    // After invalidation a fresh resolve re-queries the adapter.
    const before = tree.listCalls;
    await resolver.resolve("docs/sub/inner.txt");
    expect(tree.listCalls).toBeGreaterThan(before);
  });

  describe("same-name siblings (ambiguity policy)", () => {
    beforeEach(() => {
      tree.add("root", "dup", "directory");
      tree.add("root", "dup", "directory"); // a second "dup" under root
    });

    it('"first" (default) picks a match deterministically', async () => {
      const node = await resolver.resolve("dup");
      expect(node?.type).toBe("directory");
    });

    it('"error" throws InvalidPathError on ambiguity', async () => {
      const strict = new PathResolver(tree, { onAmbiguous: "error" });
      await expect(strict.resolve("dup")).rejects.toMatchObject({ code: "INVALID_PATH" });
    });
  });
});
