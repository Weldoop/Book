import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "golden-sessions");

interface Session {
  id: string;
  config_id: string;
  baseline: { turns: number };
  inputs: Array<{ turn: number; text: string }>;
}
interface Probe {
  after_turn: number;
  question: string;
  expect_any: string[];
}

const session = JSON.parse(readFileSync(join(dir, "uk-life-01.json"), "utf8")) as Session;
const probes = JSON.parse(readFileSync(join(dir, "uk-life-01.probes.json"), "utf8")) as Probe[];

describe("uk-life-01 golden session", () => {
  it("targets the uk-life config", () => {
    expect(session.config_id).toBe("uk-life");
  });

  it("has 125 inputs numbered 1..125 contiguously", () => {
    expect(session.inputs).toHaveLength(125);
    session.inputs.forEach((input, i) => expect(input.turn).toBe(i + 1));
    expect(session.baseline.turns).toBe(125);
  });

  it("has non-empty input text", () => {
    for (const input of session.inputs) expect(input.text.trim().length, `turn ${input.turn}`).toBeGreaterThan(0);
  });
});

describe("uk-life-01 recall probes", () => {
  it("has 12-16 probes", () => {
    expect(probes.length).toBeGreaterThanOrEqual(12);
    expect(probes.length).toBeLessThanOrEqual(16);
  });

  it("keeps after_turn within the session and sorted", () => {
    for (const p of probes) {
      expect(Number.isInteger(p.after_turn)).toBe(true);
      expect(p.after_turn).toBeGreaterThanOrEqual(1);
      expect(p.after_turn).toBeLessThanOrEqual(125);
    }
    const turns = probes.map((p) => p.after_turn);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));
  });

  it("has a question and lowercase keywords for each probe", () => {
    for (const p of probes) {
      expect(p.question.trim().length).toBeGreaterThan(0);
      expect(p.expect_any.length).toBeGreaterThanOrEqual(1);
      for (const k of p.expect_any) {
        expect(k.trim().length).toBeGreaterThan(0);
        expect(k).toBe(k.toLowerCase());
      }
    }
  });

  it("spans early, mid and late with several late recalls of early facts", () => {
    expect(probes.some((p) => p.after_turn <= 30)).toBe(true);
    expect(probes.some((p) => p.after_turn >= 50 && p.after_turn <= 100)).toBe(true);
    expect(probes.filter((p) => p.after_turn >= 100).length).toBeGreaterThanOrEqual(4);
  });
});
