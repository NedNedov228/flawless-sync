import { test } from "node:test";
import { strict as assert } from "node:assert";
import { compileExcludes, globToRegExpSource } from "../src/exclude";

void test("globToRegExpSource translates wildcards", () => {
  assert.equal(globToRegExpSource("*.dmg"), "[^/]*\\.dmg");
  assert.equal(globToRegExpSource("**/*.mp4"), "(?:.*/)?[^/]*\\.mp4");
  assert.equal(globToRegExpSource("a/**/b.md"), "a/(?:.*/)?b\\.md");
  assert.equal(globToRegExpSource("a/**"), "a/.*");
  assert.equal(globToRegExpSource("a?b.md"), "a[^/]b\\.md");
});

void test("no patterns excludes nothing", () => {
  const excluded = compileExcludes([]);
  assert.equal(excluded("07 - Archives/big.pdf"), false);
});

void test("blank lines and comments are ignored", () => {
  const excluded = compileExcludes(["", "   ", "# comment"]);
  assert.equal(excluded("note.md"), false);
});

void test("basename-only patterns match at any depth", () => {
  const excluded = compileExcludes(["*.dmg"]);
  assert.equal(excluded("99 - Meta/Cache/Obsidian-1.12.7.dmg"), true);
  assert.equal(excluded("Obsidian.dmg"), true);
  assert.equal(excluded("99 - Meta/Cache/notes.md"), false);
});

void test("double star patterns match nested paths", () => {
  const excluded = compileExcludes(["**/*.mp4"]);
  assert.equal(excluded("99 - Meta/Cache/Video Project 1.mp4"), true);
  assert.equal(excluded("Video 1.mp4"), true);
  assert.equal(excluded("02 - Areas/Uni/notes.pdf"), false);
});

void test("folder patterns exclude the folder contents", () => {
  const excluded = compileExcludes(["99 - Meta/Cache"]);
  assert.equal(excluded("99 - Meta/Cache/render.gif"), true);
  assert.equal(excluded("99 - Meta/Cache/nested/deep/file.txt"), true);
  assert.equal(excluded("99 - Meta/Other/file.txt"), false);
  // A sibling folder sharing a prefix must not be caught.
  assert.equal(excluded("99 - Meta/CacheExtra/file.txt"), false);
});

void test("single segment wildcard does not cross folders", () => {
  const excluded = compileExcludes(["99 - Meta/Cache/*"]);
  assert.equal(excluded("99 - Meta/Cache/render.gif"), true);
  assert.equal(excluded("99 - Meta/Cache/nested/deep.txt"), false);
});

void test("exact path and directory patterns coexist", () => {
  const excluded = compileExcludes(["/note.md", "attachments/**"]);
  assert.equal(excluded("note.md"), true);
  assert.equal(excluded("sub/note.md"), false);
  assert.equal(excluded("attachments/a/b.png"), true);
});

void test("windows separators are normalised", () => {
  const excluded = compileExcludes(["99 - Meta/Cache/*.dmg"]);
  assert.equal(excluded("99 - Meta\\Cache\\setup.dmg"), true);
});

void test("case sensitive matching keeps sibling folders intact", () => {
  const excluded = compileExcludes(["99 - Meta/Cache"]);
  assert.equal(excluded("99 - Meta/cache/file.txt"), false);
});
