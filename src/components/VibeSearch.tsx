import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlayer } from "@/store/player";
import * as taste from "@/lib/taste";
import { hasTauri } from "@/lib/backend";
import { parseVibe, VIBE_SUGGESTIONS, CANDIDATE_VIBES } from "@/lib/vibeSearch";
import { toast } from "@/store/toasts";
import type { Track } from "@/lib/types";
import { Icon } from "./Icons";
import { Cover } from "./Cover";

const sampleFrom = (arr: string[], n: number): string[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};
// Personalized "always-hits" suggestions, cached across remounts (keyed by library size).
let personalCache: { key: number; vibes: string[] } | null = null;

/** "Search by vibe" — type a mood ("chill rainy night") and the taste engine ranks your library by
 *  how the *sound* matches, not by tags. Lives at the top of the For You screen. */
export function VibeSearch() {
  const library = usePlayer((s) => s.library);
  const byId = useMemo(() => new Map(library.map((t) => [t.id, t])), [library]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Track[] | null>(null);
  const [matched, setMatched] = useState<string[]>([]);
  const [ran, setRan] = useState("");

  const run = useCallback(async (query: string) => {
    const text = query.trim();
    if (!text) return;
    const parsed = parseVibe(text);
    if (!parsed) { toast.info(`Couldn't read the vibe "${text}" — try words like chill, dark, energetic, bass…`); return; }
    setBusy(true); setRan(text);
    const hits = await taste.vibe(parsed.weights, parsed.bpmMin, parsed.bpmMax, 80);
    const tracks = hits.map(([id]) => byId.get(id)).filter((t): t is Track => !!t);
    setResults(tracks); setMatched(parsed.matched);
    setBusy(false);
    if (!tracks.length) toast.info(hits.length ? "Matched, but those tracks aren't in the library." : "No analyzed tracks match yet — analyze your library in Settings.");
  }, [byId]);

  const play = useCallback((from: number) => { if (results?.length) void usePlayer.getState().playFrom(results, from); }, [results]);
  const shuffle = useCallback(() => {
    if (!results?.length) return;
    const q = [...results];
    // Fisher–Yates (UI-only, determinism not needed)
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    void usePlayer.getState().playFrom(q, 0);
  }, [results]);

  const bpmLabel = useMemo(() => matched.filter((m) => m !== "fast" && m !== "slow"), [matched]);

  // #3 — probe candidate vibes against the library; keep only the ones that actually return matches,
  // so every suggested chip is one that works on YOUR music. Cached by library size.
  const [personal, setPersonal] = useState<string[]>(() => personalCache?.vibes ?? []);
  useEffect(() => {
    if (!hasTauri || library.length === 0) return;
    const key = library.length;
    if (personalCache?.key === key) { setPersonal(personalCache.vibes); return; }
    let alive = true;
    void (async () => {
      const checked = await Promise.all(CANDIDATE_VIBES.map(async (c) => {
        const p = parseVibe(c); if (!p) return null;
        try { const hits = await taste.vibe(p.weights, p.bpmMin, p.bpmMax, 12); return hits.filter(([id]) => byId.has(id)).length >= 5 ? c : null; }
        catch { return null; }
      }));
      if (!alive) return;
      const vibes = checked.filter((c): c is string => !!c);
      personalCache = { key, vibes };
      setPersonal(vibes);
    })();
    return () => { alive = false; };
  }, [library.length, byId]);

  const pool = personal.length >= 8 ? personal : VIBE_SUGGESTIONS;
  const [chips, setChips] = useState<string[]>(() => sampleFrom(personalCache?.vibes.length ? personalCache.vibes : VIBE_SUGGESTIONS, 28));
  useEffect(() => { setChips(sampleFrom(personal.length >= 8 ? personal : VIBE_SUGGESTIONS, 28)); }, [personal]);

  return (
    <section className="wp-vibe">
      <div className="wp-vibe-bar">
        <Icon name="search" size={18} color="var(--md-on-surface-variant)" />
        <input
          className="wp-vibe-input"
          value={q}
          placeholder="Search by vibe — “chill rainy night”…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(q); }}
        />
        {q && <button className="md-icon-btn wp-vibe-clear" onClick={() => { setQ(""); setResults(null); }} title="Clear"><Icon name="close" size={18} /></button>}
        <button className="wp-tonal-btn wp-btn-sm" disabled={busy} onClick={() => void run(q)}>{busy ? "…" : "Go"}</button>
      </div>

      {!results && (
        <div className="wp-vibe-chips">
          {chips.map((s) => (
            <button key={s} className="wp-vibe-chip" onClick={() => { setQ(s); void run(s); }}>{s}</button>
          ))}
          <button className="wp-vibe-chip wp-vibe-more" onClick={() => setChips(sampleFrom(pool, 28))} title={`${(personal.length >= 8 ? personal.length : VIBE_SUGGESTIONS.length)} vibes to explore`}>
            <Icon name="shuffle" size={14} /> More
          </button>
        </div>
      )}

      {results && (
        <div className="wp-vibe-results">
          <div className="wp-vibe-rhead">
            <div className="wp-row-text">
              <div className="md-title-s ellipsis">“{ran}”</div>
              <div className="md-body-s wp-muted ellipsis">
                {results.length ? `${results.length} matches` : "no matches"}
                {bpmLabel.length ? ` · ${bpmLabel.join(" · ")}` : ""}
              </div>
            </div>
            {results.length > 0 && (
              <div className="wp-vibe-ractions">
                <button className="wp-tonal-btn wp-btn-sm" onClick={() => play(0)}><Icon name="play" size={16} /> Play</button>
                <button className="md-icon-btn" title="Shuffle" onClick={shuffle}><Icon name="shuffle" size={18} /></button>
                <button className="md-icon-btn" title="Close" onClick={() => setResults(null)}><Icon name="close" size={18} /></button>
              </div>
            )}
          </div>
          <div className="wp-vibe-list">
            {results.slice(0, 60).map((t, i) => (
              <button key={t.id} className="wp-vibe-row" onClick={() => play(i)}>
                <Cover path={t.path} size={44} radius="md" />
                <div className="wp-row-text">
                  <div className="md-body-m ellipsis">{t.title}</div>
                  <div className="md-body-s wp-muted ellipsis">{t.artist}</div>
                </div>
                <Icon name="play" size={16} color="var(--md-on-surface-variant)" />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
