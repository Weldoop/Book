import { readFileSync } from "node:fs";
import { ConfigSchema, type Config, type State, type Thread } from "@book/schema";
import { coreModule } from "@book/engine";
import { describe, expect, it } from "vitest";
import { ageThreads, applyDraft, collectDue, createInitialState, overdueThreads, processOps } from "../src/index.ts";

const config: Config = ConfigSchema.parse(
  JSON.parse(readFileSync(new URL("../../../configs/uk-life/config.json", import.meta.url), "utf8")),
);

const modules = [coreModule];

function base(over: Partial<Config> = {}): Config {
  return { ...config, ...over };
}

function stateWith(threads: Partial<Thread>[], now = config.time.start): State {
  const s = createInitialState(config, modules, "s1");
  return {
    ...s,
    clock: { now },
    threads: threads.map((t, i) => ({
      id: `t${i + 1}`,
      kind: "goal" as const,
      text: `thread ${i + 1}`,
      status: "open" as const,
      entities: [],
      scale: "minor",
      warm: true,
      reminders: 0,
      last_shown_turn: 0,
      opened_turn: 0,
      ...t,
    })),
  };
}

describe("clock.skip", () => {
  it("moves the clock without counting against the per-turn action cap", () => {
    const state = stateWith([]);
    const r = processOps(state, config, modules, [{ op: "clock.skip", minutes: 540, reason: "slept the night" }]);
    expect(r.violations).toEqual([]);
    expect(r.skipped).toBe(540);
    expect(r.minutes).toBe(0);
    expect(r.state.clock.now).toBe("2026-10-03T18:20");
  });

  it("rejects a skip longer than the configured limit", () => {
    const r = processOps(stateWith([]), config, modules, [{ op: "clock.skip", minutes: 1440, reason: "slept a day" }]);
    expect(r.violations[0]).toMatchObject({ code: "skip_too_long", severity: "game_breaking" });
  });

  it("forbids skipping when the world does not allow it", () => {
    const alien = base({ time: { ...config.time, max_skip_minutes: 0, rest_note: "this species does not sleep" } });
    const r = processOps(stateWith([]), alien, modules, [{ op: "clock.skip", minutes: 60, reason: "a nap" }]);
    expect(r.violations[0]?.code).toBe("skip_forbidden");
    expect(r.violations[0]?.message).toContain("does not sleep");
  });

  it("still allows a full night, which the action cap alone would block", () => {
    const night = { op: "clock.skip", minutes: 540, reason: "slept until morning" };
    const advance = { op: "clock.advance", minutes: 540 };
    expect(processOps(stateWith([]), config, modules, [night]).violations).toEqual([]);
    const jumped = processOps(stateWith([]), config, modules, [advance]).violations[0];
    expect(jumped).toMatchObject({ code: "time_jump", severity: "fixable" });
    expect(jumped?.message).toContain("clock.skip");
    const month = processOps(stateWith([]), config, modules, [{ op: "clock.advance", minutes: 2000 }]).violations[0];
    expect(month).toMatchObject({ code: "time_jump", severity: "game_breaking" });
  });
});

describe("ageThreads", () => {
  it("spends a reminder only for threads the prompt actually showed", () => {
    const state = stateWith([{ id: "t1" }, { id: "t2" }]);
    ageThreads(state, config, ["t1"], 1);
    expect(state.threads[0]).toMatchObject({ reminders: 1, last_shown_turn: 1, warm: true });
    expect(state.threads[1]).toMatchObject({ reminders: 0, warm: true });
  });

  it("cools a thread once its reminders run out", () => {
    const state = stateWith([{ id: "t1" }]);
    for (let turn = 1; turn <= 3; turn++) ageThreads(state, config, ["t1"], turn);
    expect(state.threads[0]).toMatchObject({ reminders: 3, warm: false });
  });

  it("re-warms a cold thread as its deadline comes into view", () => {
    const state = stateWith(
      [{ id: "t1", due: "2026-10-03T18:00", warm: false, reminders: 9 }],
      "2026-10-03T09:20",
    );
    ageThreads(state, config, [], 5);
    expect(state.threads[0]).toMatchObject({ warm: true, reminders: 0 });
  });

  it("leaves a cold thread cold while its deadline is far off", () => {
    const state = stateWith([{ id: "t1", due: "2026-10-09T18:00", warm: false }], "2026-10-03T09:20");
    ageThreads(state, config, [], 5);
    expect(state.threads[0]?.warm).toBe(false);
  });

  it("ignores threads that are already resolved", () => {
    const state = stateWith([{ id: "t1", status: "resolved" }]);
    ageThreads(state, config, ["t1"], 1);
    expect(state.threads[0]?.reminders).toBe(0);
  });
});

describe("overdueThreads", () => {
  it("raises nothing while the deadline is ahead", () => {
    expect(overdueThreads(stateWith([{ due: "2026-10-05T10:00" }]), config)).toEqual([]);
  });

  it("raises the configured consequence once the deadline passes", () => {
    const state = stateWith([{ due: "2026-10-03T09:00", on_overdue: "The brambles are still there." }]);
    const [item] = overdueThreads(state, config);
    expect(item).toMatchObject({ id: "overdue:t1", kind: "scheduled", text: "The brambles are still there." });
  });

  it("falls back to a generic consequence when the config declares none", () => {
    const state = stateWith([{ due: "2026-10-03T09:00", text: "feed the cat" }]);
    expect(overdueThreads(state, config)[0]?.text).toContain("feed the cat");
  });

  it("ignores a thread that was dealt with in time", () => {
    const state = stateWith([{ due: "2026-10-03T09:00", status: "resolved" }]);
    expect(overdueThreads(state, config)).toEqual([]);
  });

  it("is reachable through collectDue, so a cold thread still bites", () => {
    const state = stateWith([{ due: "2026-10-03T09:00", warm: false }]);
    expect(collectDue(state, config, modules).map((d) => d.id)).toContain("overdue:t1");
  });

  it("fires once: applying the turn marks the thread failed", () => {
    const state = stateWith([{ due: "2026-10-03T09:00" }]);
    const due = collectDue(state, config, modules);
    const next = applyDraft(state, config, modules, { narration: "The garden wins.", delta: [], beat: "Overdue." }, {
      input: "look",
      due,
    });
    expect(next.threads[0]).toMatchObject({ status: "failed", resolved_turn: 1 });
    expect(overdueThreads(next, config)).toEqual([]);
  });
});
