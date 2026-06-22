import { useSettings } from "@/store/settings";
import { usePlayer } from "@/store/player";
import { useCover } from "./Cover";
import { Slider } from "./Slider";
import { Icon } from "./Icons";

/**
 * First-boot personalization (shown once, until `onboarded`). Lets the user dial in the album-art
 * background — blur strength + saturation — with a live preview. Everything here is also editable
 * later in Settings → Look. Writes go straight to the settings store (live), so the real app
 * background updates behind this card too.
 */
export function Onboarding() {
  const s = useSettings();
  // preview art: whatever's playing, else the first library track, else a vivid gradient placeholder
  const path = usePlayer((st) => st.current()?.path ?? st.library[0]?.path);
  const art = useCover(path);
  const blurOn = s.appBg === "blur";

  return (
    <div className="wp-onboard">
      <div className="wp-onboard-card">
        <div className="wp-onboard-head">
          <span className="wp-onboard-mark"><Icon name="graphicEq" size={24} color="var(--md-on-primary)" /></span>
          <div className="md-headline-s">Make it yours</div>
          <div className="md-body-m wp-muted">Set how the album-art background looks. You can change this anytime in Settings&nbsp;→&nbsp;Look.</div>
        </div>

        <div className={`wp-onboard-preview ${art ? "" : "wp-onboard-preview-demo"}`}>
          <div className="wp-onboard-prev-img" style={{ backgroundImage: art ? `url(${art})` : undefined, filter: `blur(${s.bgBlur}px) saturate(${s.bgSaturation})` }} />
          <div className="wp-onboard-prev-scrim" />
          <div className="wp-onboard-prev-fg">
            <div className="md-title-m">Now Playing</div>
            <div className="md-body-s">Readable over your art</div>
          </div>
        </div>

        <div className="wp-onboard-rows">
          <div className="wp-onboard-row">
            <span className="md-body-l">Background</span>
            <div className="wp-seg wp-seg-sm">
              <button className={`wp-seg-item ${!blurOn ? "wp-seg-on" : ""}`} onClick={() => s.setAppBg("off")}>Off</button>
              <button className={`wp-seg-item ${blurOn ? "wp-seg-on" : ""}`} onClick={() => s.setAppBg("blur")}>Blur art</button>
            </div>
          </div>
          <div className={`wp-onboard-row ${blurOn ? "" : "wp-disabled"}`}>
            <span className="md-body-l">Blur strength <span className="wp-muted">{Math.round(s.bgBlur)}px</span></span>
            <div className="wp-onboard-slider"><Slider value={s.bgBlur} min={0} max={120} step={2} onChange={s.setBgBlur} /></div>
          </div>
          <div className={`wp-onboard-row ${blurOn ? "" : "wp-disabled"}`}>
            <span className="md-body-l">Saturation <span className="wp-muted">{s.bgSaturation.toFixed(2)}×</span></span>
            <div className="wp-onboard-slider"><Slider value={s.bgSaturation} min={1} max={2.5} step={0.05} onChange={s.setBgSaturation} /></div>
          </div>
        </div>

        <button className="wp-filled-btn wp-onboard-done" onClick={() => s.setOnboarded(true)}>Get started</button>
      </div>
    </div>
  );
}
