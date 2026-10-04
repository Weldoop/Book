import { describe, expect, it } from "vitest";
import { flagBool, flagNumber, flagString, parseFaults, parseFlags } from "../src/index.ts";

describe("parseFlags", () => {
  it("parses command, value flags, = syntax and booleans", () => {
    const a = parseFlags(["replay", "--config", "c.json", "--max-turns=5", "--delta-first", "--out", "dir"]);
    expect(a.command).toBe("replay");
    expect(flagString(a, "config")).toBe("c.json");
    expect(flagNumber(a, "max-turns")).toBe(5);
    expect(flagBool(a, "delta-first")).toBe(true);
    expect(flagString(a, "out")).toBe("dir");
    expect(flagBool(a, "debug")).toBe(false);
  });

  it("treats a flag followed by another flag as boolean and keeps positionals", () => {
    const a = parseFlags(["report", "a.json", "--verbose", "--x", "1", "b.json"]);
    expect(a.positionals).toEqual(["a.json", "b.json"]);
    expect(a.flags.verbose).toBe(true);
    expect(a.flags.x).toBe("1");
  });

  it("delta-first does not swallow the next token", () => {
    const a = parseFlags(["play", "--delta-first", "--config", "c"]);
    expect(a.flags["delta-first"]).toBe(true);
    expect(a.flags.config).toBe("c");
  });

  it("validates numbers and valueless string flags", () => {
    expect(() => flagNumber(parseFlags(["x", "--max-turns", "abc"]), "max-turns")).toThrow(/non-negative number/);
    expect(() => flagNumber(parseFlags(["x", "--max-turns", "-3"]), "max-turns")).toThrow(/non-negative/);
    expect(() => flagString(parseFlags(["x", "--config"]), "config")).toThrow(/needs a value/);
    expect(flagNumber(parseFlags(["x"]), "max-turns")).toBeUndefined();
  });

  it("no args gives no command", () => {
    expect(parseFlags([]).command).toBeUndefined();
  });
});

describe("parseFaults", () => {
  it("parses every and kind", () => {
    expect(parseFaults("every=7,kind=game_breaking")).toEqual({ every: 7, kind: "game_breaking" });
    expect(parseFaults("kind=fixable")).toEqual({ kind: "fixable" });
  });
  it("rejects bad specs", () => {
    expect(() => parseFaults("every=0,kind=fixable")).toThrow();
    expect(() => parseFaults("every=3")).toThrow(/kind/);
    expect(() => parseFaults("kind=weird")).toThrow(/kind/);
    expect(() => parseFaults("foo=1,kind=fixable")).toThrow(/Bad --faults/);
  });
});
