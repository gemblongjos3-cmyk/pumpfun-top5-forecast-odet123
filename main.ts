import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Row = {
  rank: number;
  mint: string;
  market_cap_lamports: string;
  venue: string;
  name: string;
  symbol: string;
  created_at: string;
  complete: boolean;
  mayhem: boolean;
};
type Mark = { at: string; ok: boolean; rows: Row[] | null };
type Point = { t: number; size: number; row: Row };
type Coin = {
  mint: string;
  points: Point[];
  row: Row;
  last: number;
  stale: number;
  trend: number;
  vol: number;
  expectedRank: number;
  p1: number;
};

const task = JSON.parse(readFileSync(join(inputDir, 'task.json'), 'utf8')) as {
  reads: string[];
  history_until: string;
  places: number;
  size: { edges: number[] };
  output: string;
};
const marks = readFileSync(join(inputDir, 'history.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Mark)
  .filter((mark) => mark.ok && Array.isArray(mark.rows));
if (!marks.length) throw new Error('no usable marks');

function collectCoinPoints(history: Mark[]): Map<string, Point[]> {
  const pointsByMint = new Map<string, Point[]>();
  for (const mark of history) {
    const time = Date.parse(mark.at) / 3_600_000;
    for (const row of mark.rows!) {
      if (!row.market_cap_lamports || BigInt(row.market_cap_lamports) <= 0n) continue;
      const point: Point = {
        t: time,
        size: Math.log10(Number(BigInt(row.market_cap_lamports))) - 9,
        row,
      };
      const points = pointsByMint.get(row.mint) ?? [];
      points.push(point);
      pointsByMint.set(row.mint, points);
    }
  }
  return pointsByMint;
}

function buildCoinFeatures(pointsByMint: Map<string, Point[]>, cutoff: number): Coin[] {
  const preliminary = [...pointsByMint.entries()].map(([mint, points]) => {
    points.sort((a, b) => a.t - b.t);
    const last = points.at(-1)!;
    const deltas: Array<{ v: number; dt: number; age: number }> = [];
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1]!;
      const current = points[i]!;
      const dt = current.t - previous.t;
      if (dt > 0) deltas.push({ v: (current.size - previous.size) / dt, dt, age: cutoff - current.t });
    }

    let weightSum = 0;
    let weightedTrend = 0;
    for (const delta of deltas) {
      const weight = Math.exp(-delta.age / 0.6) * Math.min(1, delta.dt / 0.12);
      weightSum += weight;
      weightedTrend += delta.v * weight;
    }
    const rawTrend = weightSum ? weightedTrend / weightSum : 0;
    const mean = deltas.length ? deltas.reduce((sum, delta) => sum + delta.v, 0) / deltas.length : 0;
    const variance = deltas.length
      ? deltas.reduce((sum, delta) => sum + (delta.v - mean) ** 2, 0) / deltas.length
      : 0;
    const vol = Math.max(0.12, Math.sqrt(variance));
    return {
      mint,
      points,
      row: last.row,
      last: last.size,
      stale: Math.max(0, cutoff - last.t),
      rawTrend,
      vol,
      expectedRank: 0,
      p1: 0,
    };
  });

  const orderedTrends = preliminary.map((coin) => coin.rawTrend).sort((a, b) => a - b);
  const medianTrend = orderedTrends.length
    ? orderedTrends[Math.floor(orderedTrends.length / 2)]!
    : 0;
  return preliminary.map((coin) => {
    const shrink = coin.points.length / (coin.points.length + 5);
    return { ...coin, trend: medianTrend + (coin.rawTrend - medianTrend) * shrink };
  });
}

function findSizeBin(size: number, edges: number[]): number {
  if (size < edges[0]!) return 0;
  if (size >= edges.at(-1)!) return 81;

  let low = 0;
  let high = edges.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (size >= edges[middle]!) low = middle;
    else high = middle;
  }
  return low + 1;
}

function tallySimulation(
  draws: Array<{ i: number; mint: string; size: number }>,
  candidates: Coin[],
  places: number,
  edges: number[],
  rankCounts: Array<Map<string, number>>,
  sizeCounts: number[][],
): void {
  const mintOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  draws.sort((a, b) => b.size - a.size || mintOrder(a.mint, b.mint));
  for (let place = 0; place < places; place++) {
    const draw = draws[place]!;
    const coin = candidates[draw.i]!;
    rankCounts[place]!.set(draw.mint, (rankCounts[place]!.get(draw.mint) ?? 0) + 1);
    coin.expectedRank += place + 1;
    if (place === 0) coin.p1++;
    sizeCounts[place]![findSizeBin(draw.size, edges)]++;
  }
}

const pointsByMint = collectCoinPoints(marks);
const cutoff = Date.parse(marks.at(-1)!.at) / 3_600_000;
const mintOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const coins = buildCoinFeatures(pointsByMint, cutoff);
coins.sort((a, b) =>
  b.last + Math.max(-0.4, Math.min(0.4, b.trend)) * 2 -
  (a.last + Math.max(-0.4, Math.min(0.4, a.trend)) * 2) ||
  mintOrder(a.mint, b.mint)
);
const candidates = coins.slice(0, 300);
const indexByMint = new Map(candidates.map((coin, index) => [coin.mint, index]));
const places = task.places;
const reads = task.reads.map((read) => Date.parse(read) / 3_600_000);
const sims = 4000;

let observedTopFiveTurnover = 0;
let turnoverIntervals = 0;
for (let i = 1; i < marks.length; i++) {
  const previousTop = new Set(marks[i - 1]!.rows!.slice(0, 5).map((row) => row.mint));
  const currentTop = new Set(marks[i]!.rows!.slice(0, 5).map((row) => row.mint));
  observedTopFiveTurnover += 5 - [...previousTop].filter((mint) => currentTop.has(mint)).length;
  turnoverIntervals++;
}
const topFiveTurnoverRate = turnoverIntervals ? observedTopFiveTurnover / (5 * turnoverIntervals) : 0.5;
const rankCounts = Array.from({ length: places }, () => new Map<string, number>());
const sizeCounts = Array.from({ length: places }, () => new Array(82).fill(0) as number[]);
const rng = (() => {
  let a = 0x6d2b79f5;
  return () => {
    a |= 0;
    a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
})();
let spare: number | null = null;
const normal = () => {
  if (spare !== null) {
    const value = spare;
    spare = null;
    return value;
  }
  let u = 0;
  let v = 0;
  while (!u) u = rng();
  v = rng();
  const magnitude = Math.sqrt(-2 * Math.log(u));
  spare = magnitude * Math.sin(2 * Math.PI * v);
  return magnitude * Math.cos(2 * Math.PI * v);
};

for (const read of reads) {
  const horizon = Math.max(0, read - cutoff);
  for (let simulation = 0; simulation < sims; simulation++) {
    const draws = candidates.map((coin) => {
      const horizonDamp = Math.exp(-horizon / 24);
      const ageDamp = Math.exp(-coin.stale / 2);
      const drift = coin.trend * horizonDamp * ageDamp;
      // The dev window's 90th percentile adjacent absolute move was 0.109
      // log units, so retain more measured coin-specific volatility at long horizons.
      const sd = Math.sqrt(coin.vol * coin.vol * horizon * 0.30 + 0.035 * horizon) *
        (1 + Math.min(2, coin.stale * 0.7));
      let size = coin.last + drift * horizon + normal() * sd;
      const deathP = Math.min(
        0.72,
        0.025 + (1 - Math.exp(-coin.stale / 1.5)) * 0.20 + (1 - Math.exp(-horizon / 10)) * 0.18,
      );
      if (rng() < deathP) size -= 2.0 + rng() * 2.0;
      return { i: indexByMint.get(coin.mint)!, mint: coin.mint, size };
    });
    tallySimulation(draws, candidates, places, task.size.edges, rankCounts, sizeCounts);
  }
}

const total = sims * reads.length;
for (const coin of candidates) {
  coin.expectedRank /= total;
  coin.p1 /= total;
}
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
for (let place = 0; place < places; place++) {
  // Adapt unnamed mass to measured top-five churn (dev history: 3/5 per mark).
  // Longer-horizon ranks also get more entrant room at lower places.
  const newcomer = Math.min(0.62, 0.20 + topFiveTurnoverRate * 0.30 + 0.035 * place);
  const ranked = [...rankCounts[place]!.entries()]
    .map(([mint, count]) => [mint, count / total] as const)
    .filter(([, probability]) => probability >= 0.001)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);
  const sum = ranked.reduce((value, [, probability]) => value + probability, 0);
  const scale = sum ? (1 - newcomer) / sum : 0;
  for (const [mint, probability] of ranked) {
    probabilities.push({ mint, place: place + 1, p: probability * scale });
  }
}

const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let place = 0; place < places; place++) {
  const histogram = sizeCounts[place]!.map((count) => count / total);
  for (let bin = 0; bin < 82; bin++) {
    const smooth = 0.96 * histogram[bin]! +
      0.02 * (histogram[Math.max(0, bin - 1)]! + histogram[Math.min(81, bin + 1)]!);
    const probability = Math.floor(smooth * 1_000_000) / 1_000_000;
    if (probability > 0) sizes.push({ place: place + 1, bin, p: probability });
  }
}
const top5 = [...candidates]
  .sort((a, b) => a.expectedRank - b.expectedRank || b.p1 - a.p1 || mintOrder(a.mint, b.mint))
  .slice(0, places)
  .map((coin) => coin.mint);
writeFileSync(join(outputDir, task.output), `${JSON.stringify({ probabilities, top5, sizes })}\n`);
