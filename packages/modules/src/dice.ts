import type { Config, Module } from "@book/schema";

export function fateLabel(config: Config, roll: number): string {
  const dice = config.dice;
  if (!dice) return String(roll);
  const labels = dice.labels;
  if (!labels || labels.length === 0) return String(roll);
  const percent = (roll / dice.sides) * 100;
  let index = 0;
  for (const t of dice.thresholds) {
    if (percent > t) index++;
  }
  return labels[Math.min(index, labels.length - 1)] ?? String(roll);
}

export const diceModule: Module = {
  id: "dice",
  ops: [],
  initState: () => ({}),
  validateOp: () => [],
  applyOp: (_op, state) => state,

  promptFragment(config) {
    const d = config.dice;
    if (!d) return "";
    const bands = d.thresholds.map((t, i) => `${t}%${d.labels?.[i] ? ` ${d.labels[i]}` : ""}`).join(", ");
    return `FATE DIE: The engine rolls a d${d.sides} each turn (shown as FATE DIE). Use it ONLY when an action is genuinely risky or uncertain; otherwise ignore it. Never invent your own roll. Outcome bands by percentage of the die: ${bands}. Low rolls go badly, high rolls go well.`;
  },

  focus: () => [],
  due: () => [],
  snapshot: () => [],
  render: () => ({}),
};
