/** Unit tests for the pure recommendation blender. Run with:
 *    node_modules/.bin/esbuild src/lib/recommend.test.ts --bundle --platform=node --format=cjs | node
 *  (no test-runner dependency — esbuild bundles, node runs, throws on failure). */
import { buildAffinity, smartBlend, becausePlayed, hiddenGems, type Stat, type StatOf } from "./recommend";
import type { Track } from "./types";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
  passed++;
}

let n = 0;
const mk = (over: Partial<Track> = {}): Track => ({
  id: `t${++n}`, path: `t${n}.mp3`, title: `T${n}`, artist: "Nobody", album: "A", duration: 200, ...over,
});
const NOW = 1_700_000_000;
const statsOf = (m: Record<string, Partial<Stat>>): StatOf =>
  (id) => ({ rating: 0, plays: 0, lastPlayed: 0, skips: 0, ...(m[id] ?? {}) });

// 1. Affinity: a played artist gains affinity; an untouched artist stays at zero.
{
  const a = mk({ artist: "Loved", genre: "techno" });
  const b = mk({ artist: "Unknown", genre: "techno" });
  const aff = buildAffinity([a, b], statsOf({ [a.id]: { plays: 10, lastPlayed: NOW } }), NOW);
  ok((aff.artist.get("Loved") ?? 0) > 0, "played artist has affinity");
  ok(!aff.artist.has("Unknown"), "untouched artist has no affinity");
  ok((aff.genre.get("techno") ?? 0) > 0, "played genre has affinity");
}

// 2. smartBlend: cold start (no signals) → empty; with signal it returns picks led by the loved lane.
{
  const lib = [mk({ artist: "X" }), mk({ artist: "Y" })];
  const cold = buildAffinity(lib, statsOf({}), NOW);
  ok(smartBlend(lib, statsOf({}), cold, 10).length === 0, "no signals → empty blend");

  const loved = mk({ artist: "Loved", genre: "house" });
  const unheard = mk({ artist: "Loved", genre: "house" }); // discovery candidate (same artist, never played)
  const other = mk({ artist: "Random", genre: "folk" });
  const st = statsOf({ [loved.id]: { plays: 8, rating: 5, lastPlayed: NOW - 5 * 86400 } });
  const aff = buildAffinity([loved, unheard, other], st, NOW);
  const blend = smartBlend([loved, unheard, other], st, aff, 10);
  ok(blend.length >= 2, "blend returns the lane");
  ok(blend.indexOf(other) === -1 || blend.indexOf(unheard) < blend.indexOf(other), "loved-artist track ranks above an unrelated one");
}

// 3. Negative feedback: skipping a track drops it below an identical un-skipped one.
{
  const keep = mk({ artist: "Loved", genre: "house" });
  const skipped = mk({ artist: "Loved", genre: "house" });
  const stat = statsOf({
    [keep.id]: { plays: 3, lastPlayed: NOW - 10 * 86400 },
    [skipped.id]: { plays: 3, skips: 4, lastPlayed: NOW - 10 * 86400 },
  });
  const aff = buildAffinity([keep, skipped], stat, NOW);
  const blend = smartBlend([keep, skipped], stat, aff, 10);
  ok(blend.indexOf(keep) < blend.indexOf(skipped), "a heavily-skipped track ranks below an identical un-skipped one");
}

// 4. becausePlayed seeds from the strongest artist.
{
  const a1 = mk({ artist: "Seed", genre: "techno" });
  const a2 = mk({ artist: "Seed", genre: "techno" });
  const a3 = mk({ artist: "Seed", genre: "techno" });
  const b1 = mk({ artist: "Other", genre: "techno" });
  const st = statsOf({ [a1.id]: { plays: 20, lastPlayed: NOW } });
  const aff = buildAffinity([a1, a2, a3, b1], st, NOW);
  const r = becausePlayed([a1, a2, a3, b1], st, aff, 10);
  ok(r !== null && r.seed === "Seed", "because-you-played seeds from the top artist");
}

// 5. Hidden gems: loved but barely played.
{
  const gem = mk({ artist: "Z" });
  const overplayed = mk({ artist: "Z" });
  const st = statsOf({ [gem.id]: { rating: 5, plays: 0 }, [overplayed.id]: { rating: 5, plays: 50, lastPlayed: NOW } });
  const aff = buildAffinity([gem, overplayed], st, NOW);
  const gems = hiddenGems([gem, overplayed], st, aff, 10);
  ok(gems.includes(gem) && !gems.includes(overplayed), "hidden gems = highly-rated, barely-played");
}

console.log(`recommend.test: ${passed} assertions passed`);
