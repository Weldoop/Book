import { describe, expect, it } from "vitest";
import { parseDraftText } from "../src/parse.ts";

describe("parseDraftText", () => {
  it("keeps a reply that is already one object", () => {
    const parsed = parseDraftText('{"narration":"You stay put.","delta":[],"beat":"Still."}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.narration).toBe("You stay put.");
    expect(parsed.draft.delta).toEqual([]);
  });

  it("reads a narration that quotes someone without escaping", () => {
    const raw = '{"narration":"Cerys says "Proof-reading offer noted." and tops up the kettle.","delta":[],"beat":"A note."}';
    const parsed = parseDraftText(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.narration).toContain("Proof-reading offer noted.");
    expect(parsed.draft.beat).toBe("A note.");
  });

  it("drops a check that arrived as a sentence", () => {
    const raw = '{"narration":"You knock.","delta":[],"beat":"A knock.","check":"no roll"}';
    const parsed = parseDraftText(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.check).toBeUndefined();
    expect(parsed.draft.narration).toBe("You knock.");
  });
});
