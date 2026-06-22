import { useEffect, useRef, useState } from "react";

/**
 * Cross-dissolve between album-art images when `src` changes — the new image fades in over the
 * outgoing one (compositor-only opacity → cheap + smooth), so a track change "morphs" instead of
 * snapping. Pairs with the dynamic-colour crossfade for a cohesive transition. At most two layers are
 * ever mounted (outgoing + incoming); the outgoing one is dropped when the fade ends.
 */
export function CrossArt({ src, className, ms = 420 }: { src: string; className?: string; ms?: number }) {
  const idRef = useRef(0);
  const [layers, setLayers] = useState<{ key: number; src: string }[]>(() => (src ? [{ key: 0, src }] : []));

  useEffect(() => {
    if (!src) { setLayers([]); return; }
    setLayers((prev) => {
      if (prev.length && prev[prev.length - 1].src === src) return prev; // no change
      return [...prev.slice(-1), { key: ++idRef.current, src }]; // keep outgoing + incoming (max 2)
    });
  }, [src]);

  return (
    <div className={`wp-crossart ${className ?? ""}`}>
      {layers.map((l, i) => {
        const incoming = i === layers.length - 1 && layers.length > 1;
        return (
          <img
            key={l.key}
            src={l.src}
            alt=""
            draggable={false}
            decoding="async"
            className={incoming ? "wp-crossart-in" : ""}
            style={incoming ? { animationDuration: `${ms}ms` } : undefined}
            onAnimationEnd={incoming ? () => setLayers((p) => (p.length > 1 ? p.slice(-1) : p)) : undefined}
          />
        );
      })}
    </div>
  );
}
