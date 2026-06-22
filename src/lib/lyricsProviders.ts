/** External lyrics-search providers — opened in the browser / a lyrics app from Now Playing. */
export type LyricsProvider = "google" | "genius" | "musixmatch" | "azlyrics";

export const LYRICS_PROVIDERS: { id: LyricsProvider; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "genius", label: "Genius" },
  { id: "musixmatch", label: "Musixmatch" },
  { id: "azlyrics", label: "AZ" },
];

/** Build the search URL for a provider from the current track's artist + title. */
export function lyricsSearchUrl(provider: LyricsProvider, artist: string, title: string): string {
  const a = artist && artist !== "Unknown artist" ? artist : "";
  const q = `${a} ${title}`.trim();
  const e = encodeURIComponent(q);
  switch (provider) {
    case "genius": return `https://genius.com/search?q=${e}`;
    case "musixmatch": return `https://www.musixmatch.com/search/${e}`;
    case "azlyrics": return `https://search.azlyrics.com/search.php?q=${e}`;
    default: return `https://www.google.com/search?q=${encodeURIComponent(`${q} lyrics`)}`;
  }
}
