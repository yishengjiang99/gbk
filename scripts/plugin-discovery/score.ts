// Pure scoring for the plugin discovery eval (no I/O). A result records which tool, if any, the model chose first.
export interface Fixture { id: string; category: "A" | "B" | "C" | "D"; prompt: string; expect: "tool" | "no_tool" | "either"; expectedFirstTool: string[] | null; note?: string }
export interface Outcome { id: string; firstTool: string | null; error?: string }
export interface Scored extends Outcome { category: Fixture["category"]; expect: Fixture["expect"]; invokedGbk: boolean; invocationCorrect: boolean | null; firstToolCorrect: boolean | null }

export const isGbk = (t: string | null) => !!t && t.startsWith("gbk_");

export function scoreOne(f: Fixture, o: Outcome): Scored {
  const invokedGbk = isGbk(o.firstTool);
  const invocationCorrect = o.error ? null : f.expect === "either" ? null : f.expect === "tool" ? invokedGbk : !invokedGbk;
  const firstToolCorrect = o.error || f.expect !== "tool" ? null : invokedGbk && !!f.expectedFirstTool?.includes(o.firstTool!);
  return { ...o, category: f.category, expect: f.expect, invokedGbk, invocationCorrect, firstToolCorrect };
}

const ratio = (xs: (boolean | null)[]) => { const v = xs.filter((x): x is boolean => x !== null); return v.length ? { correct: v.filter(Boolean).length, total: v.length, rate: +(v.filter(Boolean).length / v.length).toFixed(3) } : { correct: 0, total: 0, rate: null }; };

export function summarize(fixtures: Fixture[], outcomes: Outcome[]) {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const scored = fixtures.filter((f) => byId.has(f.id)).map((f) => scoreOne(f, byId.get(f.id)!));
  const cat = (c: string) => scored.filter((s) => s.category === c);
  const pos = scored.filter((s) => s.expect === "tool"), neg = scored.filter((s) => s.expect === "no_tool"), border = cat("D");
  return {
    scored,
    totals: { fixtures: fixtures.length, run: scored.length, errors: scored.filter((s) => s.error).length },
    invocationAccuracy: ratio(scored.map((s) => s.invocationCorrect)),
    recall: ratio(pos.map((s) => s.invocationCorrect)),
    falsePositiveRate: neg.length ? +(neg.filter((s) => s.invokedGbk).length / neg.length).toFixed(3) : null,
    firstToolAccuracy: ratio(pos.map((s) => s.firstToolCorrect)),
    byCategory: Object.fromEntries(["A", "B", "C"].map((c) => [c, ratio(cat(c).map((s) => s.invocationCorrect))])),
    borderline: { total: border.length, invokedGbk: border.filter((s) => s.invokedGbk).length },
  };
}
