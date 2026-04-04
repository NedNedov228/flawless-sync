import { test } from "node:test";
import { strict as assert } from "node:assert";
import { StateManager } from "../src/stateManager";
import type { FileState } from "../src/types";

void test("StateManager loads a defensive copy and serializes current state", () => {
  const initialState: FileState[] = [
    {
      path: "note.md",
      localMtime: 1,
      remoteMtime: 2,
      etag: "etag-1",
    },
  ];

  const state = new StateManager();
  state.load(initialState);
  const firstState = initialState[0];
  assert.ok(firstState);
  firstState.etag = "changed-after-load";

  assert.equal(state.get("note.md")?.etag, "etag-1");
  assert.deepEqual(state.toJSON(), [
    {
      path: "note.md",
      localMtime: 1,
      remoteMtime: 2,
      etag: "etag-1",
    },
  ]);
});

void test("StateManager supports set, delete, and key iteration", () => {
  const state = new StateManager();

  state.set("a.md", {
    path: "a.md",
    localMtime: 10,
    remoteMtime: 20,
    etag: "etag-a",
  });
  state.set("b.md", {
    path: "b.md",
    localMtime: 30,
    remoteMtime: 40,
    etag: "etag-b",
  });

  assert.deepEqual(Array.from(state.keys()).sort(), ["a.md", "b.md"]);

  state.delete("a.md");

  assert.equal(state.get("a.md"), undefined);
  assert.deepEqual(Array.from(state.keys()), ["b.md"]);
});
