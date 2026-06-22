import { useState } from "react";
import { Icon } from "./Icons";
import { useBackGuard } from "@/lib/backStack";

/** Feature introduction — shown once on first launch, and re-openable any time from Settings → About.
 *  A transform-driven carousel (Next / tap a dot); `onDone` closes it. No scroll listener, so there's
 *  no layout-feedback loop to stall on. */
const SLIDES: { icon: string; title: string; body: string }[] = [
  { icon: "graphicEq", title: "Welcome to Wove", body: "A fast, beautiful player for your own music — local-first, no account, no cloud. Add a folder and you're set." },
  { icon: "tune", title: "Tuned to you", body: "A hi-fi parametric EQ, an audio-reactive visualizer, and on-device mixes that learn from what you play. We'll introduce For You and Explore when you open them." },
];

export function Intro({ onDone }: { onDone: () => void }) {
  const [page, setPage] = useState(0);
  useBackGuard(true, onDone); // Android back dismisses the intro
  const last = page >= SLIDES.length - 1;
  const next = () => (last ? onDone() : setPage((p) => Math.min(SLIDES.length - 1, p + 1)));
  return (
    <div className="wp-intro" role="dialog" aria-label="Introduction">
      <div className="wp-intro-card">
        <div className="wp-intro-viewport">
          <div className="wp-intro-track" style={{ transform: `translateX(-${page * 100}%)` }}>
            {SLIDES.map((s) => (
              <div className="wp-intro-slide" key={s.title}>
                <span className="wp-intro-mark"><Icon name={s.icon} size={30} color="var(--md-on-primary)" /></span>
                <div className="md-headline-s">{s.title}</div>
                <div className="md-body-m wp-muted">{s.body}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="wp-intro-dots">
          {SLIDES.map((_, i) => (
            <button key={i} className={`wp-qg-dot ${i === page ? "on" : ""}`} aria-label={`Slide ${i + 1}`} onClick={() => setPage(i)} />
          ))}
        </div>
        <div className="wp-intro-actions">
          {last ? <span /> : <button className="wp-text-btn md-label-l" onClick={onDone}>Skip</button>}
          <button className="wp-filled-btn" onClick={next}>{last ? "Get started" : "Next"} <Icon name="next" size={16} /></button>
        </div>
      </div>
    </div>
  );
}
