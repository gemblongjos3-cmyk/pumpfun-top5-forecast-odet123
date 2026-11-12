import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
type Row = { rank: number; mint: string; market_cap_lamports: string; venue: string; name: string; symbol: string; created_at: string; complete: boolean; mayhem: boolean };
type Mark = { at: string; ok: boolean; rows: Row[] | null };
type Point = { t: number; size: number; row: Row };
type Coin = { mint: string; points: Point[]; row: Row; last: number; stale: number; trend: number; vol: number; expectedRank: number; p1: number };

const task = JSON.parse(readFileSync(join(inputDir, 'task.json'), 'utf8')) as { reads: string[]; history_until: string; places: number; size: { edges: number[] }; output: string };
const marks = readFileSync(join(inputDir, 'history.ndjson'), 'utf8').trim().split('\n').map((s) => JSON.parse(s) as Mark).filter((m) => m.ok && Array.isArray(m.rows));
if (!marks.length) throw new Error('no usable marks');
const series = new Map<string, Point[]>();
const metadata = new Map<string, Row>();
for (const mark of marks) {
  const t = Date.parse(mark.at) / 3_600_000;
  for (const row of mark.rows!) {
    if (!row.market_cap_lamports || BigInt(row.market_cap_lamports) <= 0n) continue;
    const point = { t, size: Math.log10(Number(BigInt(row.market_cap_lamports))) - 9, row };
    const pts = series.get(row.mint) ?? [];
    pts.push(point);
    series.set(row.mint, pts);
    metadata.set(row.mint, row);
  }
}
const cut = Date.parse(marks.at(-1)!.at) / 3_600_000;
const hrs = (a: Point, b: Point) => b.t - a.t;
const prelim = [...series.entries()].map(([mint, points]) => {
  points.sort((a, b) => a.t - b.t);
  const last = points.at(-1)!;
  const deltas: Array<{ v: number; dt: number; age: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const dt = hrs(points[i - 1]!, points[i]!);
    if (dt > 0) deltas.push({ v: (points[i]!.size - points[i - 1]!.size) / dt, dt, age: cut - points[i]!.t });
  }
  let sw = 0, st = 0;
  for (const d of deltas) { const w = Math.exp(-d.age / 0.6) * Math.min(1, d.dt / 0.12); sw += w; st += d.v * w; }
  const trend = sw ? st / sw : 0;
  const mean = deltas.length ? deltas.reduce((a, d) => a + d.v, 0) / deltas.length : 0;
  const vol = Math.max(0.12, Math.sqrt(deltas.length ? deltas.reduce((a, d) => a + (d.v - mean) ** 2, 0) / deltas.length : 0));
  return { mint, points, row: last.row, last: last.size, stale: Math.max(0, cut - last.t), rawTrend: trend, vol, expectedRank: 0, p1: 0 };
});
const sortedTrend = prelim.map(c => c.rawTrend).sort((a, b) => a - b);
const medianTrend = sortedTrend.length ? sortedTrend[Math.floor(sortedTrend.length / 2)]! : 0;
const coins: Coin[] = prelim.map(c => {
  const n = c.points.length;
  const shrink = n / (n + 5);
  return { ...c, trend: medianTrend + (c.rawTrend - medianTrend) * shrink };
});
const mintOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
coins.sort((a, b) => b.last + Math.max(-0.4, Math.min(0.4, b.trend)) * 2 - (a.last + Math.max(-0.4, Math.min(0.4, a.trend)) * 2) || mintOrder(a.mint, b.mint));
const candidates = coins.slice(0, 300);
const indexByMint = new Map(candidates.map((c, i) => [c.mint, i]));
const places = task.places;
const reads = task.reads.map(x => Date.parse(x) / 3_600_000);
const sims = 4000;
let observedTopFiveTurnover = 0;
let turnoverIntervals = 0;
for (let i = 1; i < marks.length; i++) {
  const previousTop = new Set(marks[i - 1]!.rows!.slice(0, 5).map(row => row.mint));
  const currentTop = new Set(marks[i]!.rows!.slice(0, 5).map(row => row.mint));
  observedTopFiveTurnover += 5 - [...previousTop].filter(mint => currentTop.has(mint)).length;
  turnoverIntervals++;
}
const topFiveTurnoverRate = turnoverIntervals ? observedTopFiveTurnover / (5 * turnoverIntervals) : 0.5;
const rankCounts = Array.from({ length: places }, () => new Map<string, number>());
const sizeCounts = Array.from({ length: places }, () => new Array(82).fill(0) as number[]);
const rng = (() => { let a = 0x6d2b79f5; return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
let spare: number | null = null;
const normal = () => { if (spare !== null) { const z = spare; spare = null; return z; } let u = 0, v = 0; while (!u) u = rng(); v = rng(); const m = Math.sqrt(-2 * Math.log(u)); spare = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v); };
for (const read of reads) {
  const h = Math.max(0, read - cut);
  for (let s = 0; s < sims; s++) {
    const draws = candidates.map(c => {
      const horizonDamp = Math.exp(-h / 24);
      const ageDamp = Math.exp(-c.stale / 2);
      const drift = c.trend * horizonDamp * ageDamp;
      // The dev window's 90th percentile adjacent absolute move was 0.109
      // log units, so retain more measured coin-specific volatility at long horizons.
      const sd = Math.sqrt(c.vol * c.vol * h * 0.30 + 0.035 * h) * (1 + Math.min(2, c.stale * 0.7));
      let size = c.last + drift * h + normal() * sd;
      const deathP = Math.min(0.72, 0.025 + (1 - Math.exp(-c.stale / 1.5)) * 0.20 + (1 - Math.exp(-h / 10)) * 0.18);
      if (rng() < deathP) size -= 2.0 + rng() * 2.0;
      return { i: indexByMint.get(c.mint)!, mint: c.mint, size };
    });
    draws.sort((a, b) => b.size - a.size || mintOrder(a.mint, b.mint));
    for (let p = 0; p < places; p++) {
      const d = draws[p]!;
      const c = candidates[d.i]!;
      rankCounts[p]!.set(d.mint, (rankCounts[p]!.get(d.mint) ?? 0) + 1);
      c.expectedRank += p + 1;
      if (p === 0) c.p1++;
      const bin = d.size < task.size.edges[0]! ? 0 : d.size >= task.size.edges.at(-1)! ? 81 : task.size.edges.findIndex((e, j) => j < task.size.edges.length - 1 && d.size >= e && d.size < task.size.edges[j + 1]! ) + 1;
      sizeCounts[p]![bin]++;
    }
  }
}
const total = sims * reads.length;
for (const c of candidates) { c.expectedRank /= total; c.p1 /= total; }
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
for (let p = 0; p < places; p++) {
  // Adapt unnamed mass to measured top-five churn (dev history: 3/5 per mark).
  // Longer-horizon ranks also get more entrant room at lower places.
  const newcomer = Math.min(0.62, 0.20 + topFiveTurnoverRate * 0.30 + 0.035 * p);
  const ranked = [...rankCounts[p]!.entries()].map(([mint, n]) => [mint, n / total] as const).filter(([, prob]) => prob >= 0.001).sort((a, b) => b[1] - a[1]).slice(0, 100);
  const sum = ranked.reduce((a, [, prob]) => a + prob, 0);
  const scale = sum ? (1 - newcomer) / sum : 0;
  for (const [mint, prob] of ranked) probabilities.push({ mint, place: p + 1, p: prob * scale });
}
const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let p = 0; p < places; p++) {
  const hist = sizeCounts[p]!.map(n => n / total);
  for (let b = 0; b < 82; b++) {
    const smooth = 0.96 * hist[b]! + 0.02 * (hist[Math.max(0, b - 1)]! + hist[Math.min(81, b + 1)]!);
    const prob = Math.floor(smooth * 1_000_000) / 1_000_000;
    if (prob > 0) sizes.push({ place: p + 1, bin: b, p: prob });
  }
}
const top5 = [...candidates].sort((a, b) => a.expectedRank - b.expectedRank || b.p1 - a.p1 || mintOrder(a.mint, b.mint)).slice(0, places).map(c => c.mint);
writeFileSync(join(outputDir, task.output), `${JSON.stringify({ probabilities, top5, sizes })}\n`);
