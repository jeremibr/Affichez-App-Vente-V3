/* -----------------------------------------------------------------------------
   Affichez branding kit — reference component.

   To use: copy into your app, then adjust two things —
     1. `@/lib/utils` -> your own `cn()` class-merge helper (or drop it and use
        template strings).
     2. LOGO_SRC paths -> wherever you served `branding/assets/logo/*`.
   Needs `next/image`; in a non-Next app swap it for a plain <img> and keep the
   width/height ratio maths below.
   -------------------------------------------------------------------------- */

import Image from "next/image";
import { cn } from "@/lib/utils";

interface LogoProps {
  /** Rendered height in px. Width follows the wordmark's own proportions. */
  height?: number;
  /**
   * `color` is the orange wordmark for light surfaces; `white` is the same
   * artwork for the orange and black bands (the site's footer and OG card).
   */
  variant?: "color" | "white";
  className?: string;
  /** Set on above-the-fold chrome (sidebar / topbar) to avoid a logo flash. */
  priority?: boolean;
}

// The 2026 "affichez↗" wordmark, traced from affichez.ca's own SVG:
// viewBox 3516.375 × 727.446.
const LOGO_RATIO = 3516.375 / 727.446;

const LOGO_SRC = {
  color: "/brand/affichez-logo.svg",
  white: "/brand/affichez-logo-white.svg",
} as const;

/**
 * Affichez brand wordmark. Renders the real logo asset rather than an icon
 * stand-in, so the brand reads as a designed identity in the app chrome.
 */
export function Logo({
  height = 28,
  variant = "color",
  className,
  priority = false,
}: LogoProps) {
  return (
    <Image
      src={LOGO_SRC[variant]}
      alt="Affichez"
      width={Math.round(height * LOGO_RATIO)}
      height={height}
      priority={priority}
      // SVG: skip the optimizer, it has nothing to compress and stays crisp.
      unoptimized
      draggable={false}
      className={cn("select-none", className)}
    />
  );
}
