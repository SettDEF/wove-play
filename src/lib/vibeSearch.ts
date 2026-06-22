// Vibe search lexicon — turns a natural-language mood ("chill rainy night", "energetic workout",
// "dark and aggressive") into a weighted query over the taste engine's 45-dim fingerprint space.
// The math (cosine over z-scored fingerprints) lives in the Rust `taste` crate (`vibe_search`); this
// file is just the *language* layer, so adding vocabulary never touches native code.
//
// Feature names MUST match `taste/src/fingerprint.rs::FEATURE_NAMES`. Signed strengths are in
// z-score space (≈ std-devs from the library mean): +1 = "noticeably more than average", −1 = less.

export interface VibeQuery {
  weights: [string, number][]; // accumulated feature → signed strength
  bpmMin: number;              // 0 = unbounded
  bpmMax: number;
  matched: string[];          // human labels of the terms we understood (for UI feedback)
}

/** A vibe term: the phrases that trigger it + the feature pushes (and optional BPM window) it adds. */
interface Term {
  label: string;
  match: string[];                 // lowercase substrings that trigger this term
  feats?: Record<string, number>;  // feature name → signed weight
  bpmMin?: number;
  bpmMax?: number;
}

// Each entry is additive: a query may match several. Keep weights ~±1 so they compose sanely.
const TERMS: Term[] = [
  // ── energy / intensity ─────────────────────────────────────────────
  { label: "energetic", match: ["energetic", "energy", "hype", "banger", "intense", "hard", "pumping", "workout", "gym", "running"],
    feats: { flux_mean: 1.0, onset_density: 1.0, rms_mean: 0.7, rms_std: 0.6 }, bpmMin: 120 },
  { label: "chill", match: ["chill", "chilled", "relax", "relaxing", "calm", "mellow", "lofi", "lo-fi", "easy", "laid back", "laidback", "lazy"],
    feats: { flux_mean: -1.0, onset_density: -0.7, rms_mean: -0.5, centroid_mean: -0.4 }, bpmMax: 110 },
  { label: "aggressive", match: ["aggressive", "angry", "heavy", "brutal", "harsh", "metal", "rage"],
    feats: { flux_mean: 1.2, zcr_mean: 0.9, flatness_mean: 0.5, rms_mean: 0.6 } },
  { label: "peaceful", match: ["peaceful", "gentle", "soft", "quiet", "ambient", "soothing", "meditative", "meditation"],
    feats: { rms_mean: -1.0, flux_mean: -0.8, onset_density: -1.0, crest: 0.5 } },

  // ── brightness / tone ──────────────────────────────────────────────
  { label: "bright", match: ["bright", "shiny", "crisp", "airy", "sparkly", "shimmer"],
    feats: { centroid_mean: 1.0, rolloff_mean: 0.8 } },
  { label: "dark", match: ["dark", "moody", "gloomy", "murky", "deep", "shadow"],
    feats: { centroid_mean: -1.0, rolloff_mean: -0.7, low_end: 0.5 } },
  { label: "warm", match: ["warm", "cozy", "smooth", "soulful", "rounded"],
    feats: { centroid_mean: -0.6, flux_mean: -0.5, flatness_mean: -0.6 } },

  // ── low end / body ─────────────────────────────────────────────────
  { label: "bass-heavy", match: ["bass", "bassy", "sub", "boomy", "808", "low end", "lowend"],
    feats: { low_end: 1.2, centroid_mean: -0.4 } },
  { label: "punchy", match: ["punchy", "punch", "snappy", "tight", "groovy", "groove"],
    feats: { rms_std: 1.0, crest: 0.8, onset_density: 0.5 } },

  // ── texture / harmony ──────────────────────────────────────────────
  { label: "tonal", match: ["melodic", "tonal", "harmonic", "pretty", "tuneful"],
    feats: { flatness_mean: -1.0, chroma_entropy: -0.8 } },
  { label: "noisy", match: ["noisy", "gritty", "lofi", "lo-fi", "raw", "distorted", "fuzzy", "crunchy"],
    feats: { flatness_mean: 1.0, zcr_mean: 0.8 } },
  { label: "atonal", match: ["experimental", "weird", "abstract", "dissonant", "atonal"],
    feats: { chroma_entropy: 1.0, flatness_mean: 0.5 } },
  { label: "dynamic", match: ["dynamic", "cinematic", "epic", "dramatic", "orchestral", "swells"],
    feats: { crest: 1.0, rms_std: 0.7 } },

  // ── tempo words (no feature push, just a BPM gate) ──────────────────
  { label: "fast", match: ["fast", "uptempo", "up-tempo", "speedy", "quick"], feats: { tempo_z: 0.8, onset_density: 0.4 }, bpmMin: 130 },
  { label: "slow", match: ["slow", "downtempo", "down-tempo", "ballad", "sleepy", "drowsy"], feats: { tempo_z: -0.8 }, bpmMax: 95 },

  // ── scene / mood shorthands ────────────────────────────────────────
  { label: "night", match: ["night", "nighttime", "late night", "midnight", "3am", "after hours", "afterhours"],
    feats: { centroid_mean: -0.6, rms_mean: -0.4, flux_mean: -0.4 } },
  { label: "rainy", match: ["rain", "rainy", "stormy", "grey", "gray", "melancholy", "melancholic", "sad", "wistful"],
    feats: { centroid_mean: -0.5, flatness_mean: -0.4, crest: 0.5, flux_mean: -0.5 } },
  { label: "happy", match: ["happy", "uplifting", "feel good", "feelgood", "joyful", "sunny", "summer", "party"],
    feats: { centroid_mean: 0.7, flux_mean: 0.5, onset_density: 0.5 }, bpmMin: 110 },
  { label: "focus", match: ["focus", "study", "studying", "concentration", "work", "coding", "reading"],
    feats: { flux_mean: -0.7, onset_density: -0.4, rms_std: -0.5, chroma_entropy: -0.3 } },
  { label: "driving", match: ["driving", "drive", "road", "highway", "cruise", "cruising"],
    feats: { onset_density: 0.6, rms_mean: 0.4, low_end: 0.4 }, bpmMin: 100 },
  { label: "danceable", match: ["dance", "dancey", "danceable", "club", "house", "techno", "edm", "rave"],
    feats: { onset_density: 1.0, low_end: 0.7, flux_mean: 0.5 }, bpmMin: 118 },

  // ── genres-as-vibes (mapped to a sound profile, not a tag — so "jazzy"/"metal"/"house" work) ──
  { label: "jazzy", match: ["jazz", "jazzy", "swing", "bebop"], feats: { flatness_mean: -0.6, chroma_entropy: 0.4, crest: 0.5, flux_mean: -0.3 } },
  { label: "hip-hop", match: ["hip hop", "hip-hop", "hiphop", "rap", "trap", "boom bap", "boombap"], feats: { low_end: 1.0, onset_density: 0.4, rms_std: 0.6 }, bpmMin: 80, bpmMax: 110 },
  { label: "rock", match: ["rock", "indie rock", "garage", "grunge", "alt rock"], feats: { flux_mean: 0.6, zcr_mean: 0.5, rms_mean: 0.5 } },
  { label: "classical", match: ["classical", "orchestral", "symphony", "piano", "strings", "baroque"], feats: { crest: 1.0, rms_std: 0.9, flatness_mean: -0.7, low_end: -0.3 } },
  { label: "funky", match: ["funk", "funky", "soul", "disco", "motown"], feats: { rms_std: 0.7, crest: 0.6, low_end: 0.5, onset_density: 0.5 }, bpmMin: 100, bpmMax: 125 },
  { label: "pop", match: ["pop", "synthpop", "k-pop", "kpop", "radio"], feats: { centroid_mean: 0.4, flux_mean: 0.4, onset_density: 0.4 } },
  { label: "acoustic", match: ["acoustic", "folk", "singer-songwriter", "unplugged", "country"], feats: { rms_mean: -0.4, flatness_mean: -0.6, centroid_mean: -0.2 } },
  { label: "reggae", match: ["reggae", "dub", "dancehall", "ska"], feats: { low_end: 0.8, onset_density: -0.2, rms_std: 0.5 }, bpmMax: 100 },
  { label: "punk", match: ["punk", "hardcore", "thrash"], feats: { flux_mean: 1.0, zcr_mean: 0.9, rms_mean: 0.6 }, bpmMin: 150 },
  { label: "drum-and-bass", match: ["drum and bass", "drum n bass", "dnb", "jungle", "breakbeat"], feats: { onset_density: 1.2, low_end: 0.8, flux_mean: 0.6 }, bpmMin: 160 },
  { label: "dubstep", match: ["dubstep", "riddim", "brostep"], feats: { low_end: 1.2, flux_mean: 0.7, rms_std: 0.8 } },
  { label: "synthwave", match: ["synthwave", "retrowave", "vaporwave", "outrun"], feats: { centroid_mean: 0.5, flux_mean: 0.3, chroma_entropy: -0.3 }, bpmMax: 115 },
];

// ── Semantic expansion (#5, pragmatic): hundreds of natural words → an existing trigger word, so
// arbitrary phrases resolve without a trained embedding. Every VALUE must be a real trigger above. ──
const SYNONYMS: Record<string, string> = {
  // emotions — positive
  euphoric: "uplifting", ecstatic: "uplifting", hopeful: "uplifting", optimistic: "uplifting", inspiring: "uplifting", inspirational: "uplifting",
  triumphant: "epic", heroic: "epic", anthemic: "epic", victorious: "epic", grandiose: "epic", majestic: "epic",
  joyful: "happy", cheerful: "happy", playful: "happy", carefree: "happy", fun: "happy", bouncy: "happy", giddy: "happy", upbeat: "happy",
  // emotions — calm
  blissful: "peaceful", serene: "peaceful", tranquil: "peaceful", zen: "peaceful", calming: "peaceful", relaxation: "peaceful", unwind: "chill",
  romantic: "warm", sensual: "warm", intimate: "warm", loving: "warm", tender: "gentle", sweet: "warm",
  // emotions — sad / dark
  nostalgic: "melancholy", wistful: "melancholy", bittersweet: "melancholy", longing: "melancholy", somber: "melancholy", melancholic: "melancholy",
  mournful: "sad", sorrowful: "sad", lonely: "sad", heartbreak: "sad", heartbroken: "sad", tearful: "sad", depressing: "sad", blue: "sad",
  ominous: "dark", sinister: "dark", eerie: "dark", spooky: "dark", haunting: "dark", creepy: "dark", evil: "dark", menacing: "dark", brooding: "dark", anxious: "dark", tense: "dark", grim: "gloomy",
  // emotions — intense
  furious: "aggressive", violent: "aggressive", savage: "aggressive", fierce: "aggressive", relentless: "aggressive", mosh: "aggressive",
  // weather / season / time
  sunny: "happy", sunshine: "happy", summery: "summer", tropical: "happy", beach: "happy",
  autumn: "melancholy", autumnal: "melancholy", winter: "dark", wintry: "dark", snow: "peaceful", cozy: "warm",
  raining: "rainy", drizzle: "rainy", storm: "stormy", thunder: "stormy", foggy: "grey", overcast: "grey", cloudy: "grey", gloom: "gloomy",
  sunrise: "bright", dawn: "bright", daytime: "bright", sunset: "warm", dusk: "night", evening: "night", twilight: "night", nocturnal: "night",
  // activities / scenes
  festival: "party", celebration: "party", clubbing: "club", dancefloor: "dance",
  yoga: "peaceful", spa: "peaceful", mindfulness: "meditation", decompress: "chill",
  studying: "study", homework: "study", productivity: "focus", concentrate: "focus", deepwork: "focus",
  jogging: "running", marathon: "running", cardio: "workout", lifting: "gym", training: "workout", exercise: "workout", hiit: "workout",
  commute: "driving", subway: "driving", traffic: "driving", roadtrip: "road", cruising: "cruise",
  cooking: "chill", morning: "bright", wakeup: "bright", bedtime: "sleepy", nap: "sleepy", lullaby: "sleepy", dreamy: "sleepy", dreaming: "sleepy",
  gaming: "energetic", hacking: "focus",
  // texture / descriptors
  ethereal: "airy", celestial: "airy", spacey: "airy", atmospheric: "airy", floaty: "airy", lush: "warm", velvety: "smooth", silky: "smooth", glossy: "shiny", glittery: "shiny", shimmering: "shiny",
  hypnotic: "chill", trippy: "experimental", psychedelic: "experimental", glitchy: "experimental", avant: "experimental",
  thumping: "bass", thick: "bass", subby: "bass", rumbling: "bass", wobble: "bass",
  frantic: "fast", frenetic: "fast", breakneck: "fast", blistering: "fast", racing: "fast", rapid: "fast",
  laidback: "chill", hazy: "chill", woozy: "slow", drowsy: "slow",
  dirty: "gritty", grimy: "gritty", filthy: "gritty", scuzzy: "gritty",
  beautiful: "melodic", catchy: "melodic", hooky: "melodic", harmonious: "melodic",
  // genres / slang
  rnb: "soulful", neosoul: "soulful", motown: "funk", boogie: "funk",
  grime: "hip hop", drill: "hip hop", phonk: "trap", boombap: "hip hop",
  shoegaze: "fuzzy", postpunk: "punk", emo: "rock", britpop: "rock", indie: "rock", alternative: "rock", metalcore: "metal", deathmetal: "metal", blackmetal: "metal",
  bigroom: "house", deephouse: "house", techhouse: "house", trance: "edm", hardstyle: "hardcore", gabber: "hardcore",
  orchestra: "orchestral", symphonic: "orchestral", filmscore: "cinematic", soundtrack: "cinematic",
  bossanova: "jazz", lounge: "jazz", smoothjazz: "jazz",
  afrobeats: "funky", afrobeat: "funky", latin: "party", reggaeton: "party", amapiano: "house", kpop: "pop", jpop: "pop",
};
// ── Fuzzy lexical fallback (#5 "any word works", in-repo) ───────────────────────────────────────
// A true text→feature embedding needs an offline-trained word-vector asset we can't generate here.
// Short of that, this resolves UNKNOWN words to the nearest word we DO understand by (a) stemming
// common suffixes and (b) a capped edit distance — catching morphology ("energising"→"energetic",
// "darkness"→"dark") and typos ("chil"→"chill") with zero shipped data. `resolveUnknown` is the
// single seam a real embedding would replace later.

// Every word we understand: term triggers (single-word) + synonym keys. Synonym keys resolve through
// SYNONYMS to a real trigger; triggers map to themselves.
const VOCAB: string[] = (() => {
  const set = new Set<string>();
  for (const t of TERMS) for (const m of t.match) if (!m.includes(" ")) set.add(m);
  for (const k in SYNONYMS) set.add(k);
  return [...set];
})();

const STOP = new Set([
  "the", "and", "for", "with", "some", "that", "this", "music", "song", "songs", "tracks", "track",
  "play", "want", "need", "like", "feel", "feeling", "vibe", "vibes", "mood", "moods", "something",
  "anything", "stuff", "give", "make", "into", "from", "more", "really", "very", "kinda", "bit",
]);

/** Strip one layer of common English inflection so "darkness"/"energising"/"dreamy" reduce toward a
 *  shared stem. Crude on purpose — it only needs to make two related words collide. */
const stem = (w: string) => w.replace(/(iness|ness|ising|izing|ising|ation|ing|ed|ly|ous|y|s)$/i, "");

/** Levenshtein distance with an early-out once it provably exceeds `max` (keeps the scan cheap). */
function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Map an unrecognised token to the closest vocabulary word (→ its canonical trigger), or null. */
function resolveUnknown(tok: string): string | null {
  if (tok.length < 4 || STOP.has(tok) || VOCAB.includes(tok)) return null;
  const ts = stem(tok);
  let best: string | null = null, bestD = Infinity;
  const max = tok.length <= 5 ? 1 : 2;
  for (const w of VOCAB) {
    const d = stem(w) === ts ? 0 : lev(tok, w, max); // shared stem beats raw edit distance
    if (d < bestD) { bestD = d; best = w; if (d === 0) break; }
  }
  if (best === null || bestD > max) return null;
  return SYNONYMS[best] ?? best; // resolve synonym keys to a real trigger word
}

/** Inject canonical trigger words for any recognised synonyms, then fuzzy-resolve leftover unknowns. */
function expand(q: string): string {
  let aug = q;
  for (const k in SYNONYMS) if (q.includes(k)) aug += ` ${SYNONYMS[k]}`;
  for (const tok of q.split(/[^a-z0-9]+/)) { const hit = resolveUnknown(tok); if (hit) aug += ` ${hit}`; }
  return aug;
}

/** Pull an explicit BPM window out of free text, e.g. "120-130 bpm", "around 128 bpm", ">140 bpm". */
function parseBpm(q: string): { min: number; max: number } | null {
  const range = q.match(/(\d{2,3})\s*[-–to]+\s*(\d{2,3})\s*bpm/);
  if (range) return { min: Math.min(+range[1], +range[2]), max: Math.max(+range[1], +range[2]) };
  const around = q.match(/(?:around|~|near|about)?\s*(\d{2,3})\s*bpm/);
  if (around) { const b = +around[1]; return { min: b - 6, max: b + 6 }; }
  const gt = q.match(/[>≥]\s*(\d{2,3})\s*bpm/); if (gt) return { min: +gt[1], max: 0 };
  const lt = q.match(/[<≤]\s*(\d{2,3})\s*bpm/); if (lt) return { min: 0, max: +lt[1] };
  return null;
}

/**
 * Parse a free-text vibe into a weighted fingerprint query. Multiple terms compose; duplicate
 * feature pushes are summed then clamped to ±2. An explicit "NNN bpm" overrides term BPM hints.
 * Returns `null` if nothing was understood (UI should show a hint, not search).
 */
const INTENSIFY = ["very ", "super ", "really ", "so ", "extremely ", "mega ", "ultra ", "mad ", "insanely ", "hella "];
const SOFTEN = ["slightly ", "kinda ", "kind of ", "a bit ", "bit ", "somewhat ", "lightly ", "a little ", "semi ", "mildly "];
const NEGATE = ["not ", "no ", "less ", "without ", "anti ", "non ", "never ", "minus ", "isn't ", "aint "];
/** Strength multiplier for a term from the word right before its trigger: very=×1.6, slightly=×0.5,
 *  not/no=negate (×−1). Lets "very dark", "slightly fast", "not aggressive" all work. */
function modifierFor(q: string, trigger: string): number {
  const i = q.indexOf(trigger);
  if (i <= 0) return 1;
  const before = q.slice(Math.max(0, i - 16), i);
  if (NEGATE.some((m) => before.endsWith(m))) return -1;
  if (INTENSIFY.some((m) => before.endsWith(m))) return 1.6;
  if (SOFTEN.some((m) => before.endsWith(m))) return 0.5;
  return 1;
}

export function parseVibe(query: string): VibeQuery | null {
  const q = query.toLowerCase();
  const aug = expand(q); // original + injected canonical words for any recognised synonyms
  const acc: Record<string, number> = {};
  const matched: string[] = [];
  let bpmMin = 0, bpmMax = 0;

  for (const term of TERMS) {
    const trig = term.match.find((m) => aug.includes(m));
    if (!trig) continue;
    const mult = modifierFor(aug, trig);
    matched.push(mult < 0 ? `not ${term.label}` : mult > 1 ? `very ${term.label}` : mult < 1 ? `slightly ${term.label}` : term.label);
    for (const [f, w] of Object.entries(term.feats || {})) acc[f] = (acc[f] || 0) + w * mult;
    // BPM gates only apply to POSITIVE matches (negation shouldn't impose the term's window)
    if (mult > 0) {
      if (term.bpmMin) bpmMin = Math.max(bpmMin, term.bpmMin);
      if (term.bpmMax) bpmMax = bpmMax ? Math.min(bpmMax, term.bpmMax) : term.bpmMax;
    }
  }

  const explicit = parseBpm(q);
  if (explicit) { bpmMin = explicit.min; bpmMax = explicit.max; }

  // a contradictory window (e.g. "chill" min<max collision) → drop the gate, keep the timbre push
  if (bpmMin && bpmMax && bpmMin > bpmMax) { bpmMin = 0; bpmMax = 0; }

  const weights = Object.entries(acc)
    .map(([f, w]) => [f, Math.max(-2, Math.min(2, w))] as [string, number])
    .filter(([, w]) => w !== 0);

  if (!weights.length && !(bpmMin || bpmMax)) return null;
  return { weights, bpmMin, bpmMax, matched };
}

// ── Vibe suggestions: generated by crossing recognised adjectives × scenes (every word below is a
// real trigger above, so each phrase always parses) → 200+ example vibes, minus obvious clashes. ──
const VIBE_ADJ = [
  "Chill", "Energetic", "Dark", "Bright", "Warm", "Moody", "Aggressive", "Peaceful", "Punchy",
  "Bassy", "Melodic", "Gritty", "Cinematic", "Hype", "Mellow", "Smooth", "Epic", "Happy", "Soulful",
  "Raw", "Dreamy", "Heavy", "Sad", "Groovy",
];
const VIBE_SCENE = [
  "rainy night", "late-night drive", "summer party", "workout", "study session", "club night",
  "road trip", "midnight", "after hours", "focus flow", "coding session", "gym", "sunset cruise",
  "deep house", "techno set", "ambient calm", "metal rage", "lofi beats", "feel-good summer",
  "melancholy evening", "rave", "highway cruise", "sunday morning", "3am", "bass club",
];
// energy classes so we don't suggest "Peaceful metal rage" / "Aggressive ambient calm".
const LOW_ADJ = new Set(["Chill", "Peaceful", "Mellow", "Smooth", "Soulful", "Warm", "Dreamy", "Sad"]);
const HIGH_ADJ = new Set(["Energetic", "Aggressive", "Hype", "Punchy", "Heavy"]);
const HIGH_SCENE = new Set(["workout", "club night", "techno set", "metal rage", "rave", "gym", "deep house", "bass club"]);
const LOW_SCENE = new Set(["ambient calm", "study session", "focus flow", "melancholy evening", "sunday morning", "3am", "midnight"]);
const clash = (a: string, s: string) => (LOW_ADJ.has(a) && HIGH_SCENE.has(s)) || (HIGH_ADJ.has(a) && LOW_SCENE.has(s));
const capFirst = (s: string) => s[0].toUpperCase() + s.slice(1);

function buildVibeSuggestions(): string[] {
  const out = new Set<string>();
  for (const s of VIBE_SCENE) out.add(capFirst(s));        // scenes alone
  for (const a of VIBE_ADJ) for (const s of VIBE_SCENE) if (!clash(a, s)) out.add(`${a} ${s}`);
  return [...out];                                          // ~250 valid vibes
}

/** The full pool of example vibes (200+). The UI shows a rotating sample, not all at once. */
export const VIBE_SUGGESTIONS = buildVibeSuggestions();

/** Pick `n` random suggestions (for the rotating chip row). */
export function sampleVibes(n: number): string[] {
  const pool = [...VIBE_SUGGESTIONS];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

/** A diverse probe set spanning moods + genres + scenes. The UI runs each against the library and
 *  keeps only the ones that actually return matches → personalized "always-hits" suggestions (#3). */
export const CANDIDATE_VIBES = [
  "Chill", "Energetic", "Dark", "Bright", "Warm", "Bassy", "Melodic", "Aggressive", "Peaceful", "Punchy",
  "Happy", "Melancholy", "Fast", "Slow", "Danceable club", "Late night", "Rainy day", "Focus flow", "Driving", "Dreamy",
  "Jazzy", "Hip-hop", "Rock", "Classical", "Funky", "Pop", "Acoustic", "House", "Techno", "Metal",
  "Ambient", "Synthwave", "Drum and bass", "Reggae", "Punk", "Cinematic", "Groovy", "Soulful", "Gritty", "Hype",
];
