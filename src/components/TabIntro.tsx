import { Icon } from "./Icons";
import { useBackGuard } from "@/lib/backStack";

/** A single-card, first-visit introduction for a screen (Explore / For You). Deliberately ONE card with a
 *  few bullet points — not a multi-slide carousel — so it explains the page at a glance and gets out of the
 *  way. Shown once (gated by a settings flag); `onClose` marks it seen. */
export function TabIntro({ icon, title, body, points, onClose }: {
  icon: string;
  title: string;
  body: string;
  points?: { icon: string; text: string }[];
  onClose: () => void;
}) {
  useBackGuard(true, onClose); // Android back dismisses it
  return (
    <div className="wp-intro" role="dialog" aria-label={title}>
      <div className="wp-intro-card">
        <div className="wp-intro-slide">
          <span className="wp-intro-mark"><Icon name={icon} size={30} color="var(--md-on-primary)" /></span>
          <div className="md-headline-s">{title}</div>
          <div className="md-body-m wp-muted">{body}</div>
        </div>
        {points && points.length > 0 && (
          <ul className="wp-intro-points">
            {points.map((p) => (
              <li className="wp-intro-point" key={p.text}>
                <span className="wp-intro-point-ic"><Icon name={p.icon} size={16} color="var(--md-primary)" /></span>
                <span className="md-body-s">{p.text}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="wp-intro-actions">
          <span />
          <button className="wp-filled-btn" onClick={onClose}>Got it <Icon name="next" size={16} /></button>
        </div>
      </div>
    </div>
  );
}
