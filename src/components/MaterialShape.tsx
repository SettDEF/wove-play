import { CSSProperties, ReactNode, useId } from "react";
import { MATERIAL_SHAPES, MaterialShapeName } from "./materialShapes";

/**
 * A filled Material 3 expressive shape (ported from the Quickshell shapes lib).
 * Paths live in a normalized 0..1 viewBox, so the SVG just scales to `size`.
 *
 *   <MaterialShape shape="cookie6Sided" size={40} color="var(--md-primary)" />
 */
export function MaterialShape({
  shape,
  size = 24,
  color = "currentColor",
  className,
  style,
  title,
}: {
  shape: MaterialShapeName;
  size?: number | string;
  color?: string;
  className?: string;
  style?: CSSProperties;
  /** When set, the shape is exposed to assistive tech with this label. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 1 1"
      width={size}
      height={size}
      className={className}
      style={style}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <path d={MATERIAL_SHAPES[shape]} fill={color} />
    </svg>
  );
}

/**
 * Clips arbitrary content into a Material shape — e.g. mask album art into a
 * cookie or clover. The shape paths are in 0..1 space, which is exactly
 * `objectBoundingBox` units, so the same path data doubles as a CSS clip-path.
 *
 *   <MaterialShapeClip shape="clover4Leaf" style={{ width: 96, height: 96 }}>
 *     <img src={coverUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
 *   </MaterialShapeClip>
 */
export function MaterialShapeClip({
  shape,
  className,
  style,
  children,
}: {
  shape: MaterialShapeName;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  // useId() yields ":r0:"-style strings; strip the colons so they're valid in
  // a CSS url(#...) reference.
  const clipId = `ms-${shape}-${useId().replace(/:/g, "")}`;
  return (
    <div
      className={className}
      style={{ ...style, clipPath: `url(#${clipId})`, WebkitClipPath: `url(#${clipId})` }}
    >
      <svg width={0} height={0} aria-hidden style={{ position: "absolute" }}>
        <defs>
          <clipPath id={clipId} clipPathUnits="objectBoundingBox">
            <path d={MATERIAL_SHAPES[shape]} />
          </clipPath>
        </defs>
      </svg>
      {children}
    </div>
  );
}
