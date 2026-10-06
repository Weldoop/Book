import type { Module } from "@book/schema";

/** Marker module: the simulator itself runs in @book/runtime when a large time skip is committed. */
export const offscreenModule: Module = {
  id: "offscreen",
  ops: [],
  initState: () => ({}),
  validateOp: () => [],
  applyOp: (_op, state) => state,
  promptFragment: () =>
    "OFFSCREEN: Facts marked '(while you were away)' on a character describe what they did while time passed. Reveal them naturally when the player next meets or contacts that character.",
  focus: () => [],
  due: () => [],
  snapshot: () => [],
  render: () => ({}),
};
