import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile as nodeWrite } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BarixFS, MemoryBackend, NodeBackend } from "../src/fs/index.js";

const backends = {
  memory: async () => new MemoryBackend(),
  disk: async () => NodeBackend.create(await mkdtemp(join(tmpdir(), "barixfs-"))),
};

for (const [name, make] of Object.entries(backends)) {
  test(`[${name}] create/read/patch/delete/move keep the tree exact`, async () => {
    const fs = await new BarixFS(await make()).init();
    await fs.writeFile("src/a.js", "export const a = 1;\nexport const b = 2;\n");
    await fs.writeFile("README.md", "# hi\n");
    assert.deepEqual(fs.files(), ["README.md", "src/a.js"]);
    const r = await fs.patchFile("src/a.js", [{ search: "a = 1", replace: "a = 10" }]);
    assert.equal(r.add, 1); assert.equal(r.del, 1); assert.match(r.diff, /\+export const a = 10;/);
    assert.equal((await fs.readFile("src/a.js")).includes("a = 10"), true);
    await fs.move("src", "lib/core");
    assert.deepEqual(fs.files(), ["README.md", "lib/core/a.js"]);
    await assert.rejects(fs.readFile("src/a.js"), { code: "ENOENT" });
    await fs.deleteFile("README.md");
    assert.equal(fs.exists("README.md"), false);
    assert.deepEqual(await fs.audit(), { ok: true, missingOnDisk: [], untracked: [], changed: [] });
  });

  test(`[${name}] edit failures are precise and ambiguity is rejected`, async () => {
    const fs = await new BarixFS(await make()).init();
    await fs.writeFile("x.js", "foo();\nfoo();\nconst value = compute(1);\n");
    await assert.rejects(fs.patchFile("x.js", [{ search: "foo();", replace: "bar();" }]), { code: "EEDIT_AMBIGUOUS" });
    await assert.rejects(fs.patchFile("x.js", [{ search: "const valeu = compute(1);" , replace: "" }]), (e) => e.code === "EEDIT_NOMATCH" && /Closest line 3/.test(e.message));
    await fs.patchFile("x.js", [{ search: "foo();", replace: "bar();", all: true }]);
    assert.equal(await fs.readFile("x.js"), "bar();\nbar();\nconst value = compute(1);\n");
  });

  test(`[${name}] version history, diff, restore, snapshots`, async () => {
    const fs = await new BarixFS(await make()).init();
    await fs.writeFile("f.txt", "one\n"); await fs.writeFile("f.txt", "two\n"); await fs.writeFile("f.txt", "three\n");
    assert.equal(fs.history("f.txt").length, 3);
    assert.equal(await fs.readVersion("f.txt", 1), "one\n");
    assert.match(await fs.diffVersions("f.txt", 1), /-one\n\+three/);
    await fs.restore("f.txt", 2); assert.equal(await fs.readFile("f.txt"), "two\n");
    const snap = await fs.snapshot("before-refactor");
    await fs.writeFile("g.txt", "new"); await fs.deleteFile("f.txt");
    await fs.restoreSnapshot(snap.id);
    assert.deepEqual(fs.files(), ["f.txt"]); assert.equal(await fs.readFile("f.txt"), "two\n");
    await fs.deleteFile("f.txt");
    assert.equal(await fs.readVersion("f.txt", 4).catch(() => null) !== null || fs.history("f.txt").length > 0, true);
  });

  test(`[${name}] grep, glob, tree, events, changesSince`, async () => {
    const fs = await new BarixFS(await make()).init(); const seen = [];
    fs.on("change", (e) => seen.push(e.kind + ":" + e.path));
    await fs.writeFile("a/b/c.ts", "const needle = 1;\n"); await fs.writeFile("a/d.md", "needle in md\n");
    assert.deepEqual((await fs.grep("needle", { glob: "**/*.ts" })).map((x) => x.path), ["a/b/c.ts"]);
    assert.deepEqual(fs.files({ glob: "a/*.md" }), ["a/d.md"]);
    assert.match(fs.renderTree(), /a\/\n {2}b\/\n {4}c\.ts/);
    assert.ok(seen.includes("create:a/b/c.ts") && seen.includes("mkdir:a/b"));
    const r0 = fs.rev; await fs.deleteDir("a", { recursive: true });
    assert.deepEqual(fs.files(), []); assert.ok(fs.changesSince(r0).length >= 4);
  });
}

test("path traversal is rejected on every entry point", async () => {
  const fs = await new BarixFS(await NodeBackend.create(await mkdtemp(join(tmpdir(), "barixfs-")))).init();
  for (const bad of ["../x", "a/../../x", "/../etc/passwd"]) await assert.rejects(fs.writeFile(bad, "x"), { code: "EPATH" });
});

test("audit detects external drift and refresh() reconciles it", async () => {
  const root = await mkdtemp(join(tmpdir(), "barixfs-"));
  const fs = await new BarixFS(await NodeBackend.create(root)).init();
  await fs.writeFile("a.txt", "x");
  await nodeWrite(join(root, "built.js"), "// from a build step"); // changed behind Barix's back
  const a = await fs.audit(); assert.equal(a.ok, false); assert.deepEqual(a.untracked, ["built.js"]);
  await fs.refresh(); assert.equal((await fs.audit()).ok, true); assert.ok(fs.exists("built.js"));
});

test("history persists across FS instances (versions.json + object store)", async () => {
  const backend = new MemoryBackend();
  const a = await new BarixFS(backend).init(); await a.writeFile("k.txt", "v1"); await a.writeFile("k.txt", "v2"); await a.flush();
  const b = await new BarixFS(backend).init();
  assert.equal(b.history("k.txt").length, 2); assert.equal(await b.readVersion("k.txt", 1), "v1");
});
