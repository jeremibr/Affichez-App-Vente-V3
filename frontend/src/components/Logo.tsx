import { cn } from '../lib/utils';

/**
 * The Affichez wordmark - lowercase, with the z drawn as a square arrow ↗.
 *
 * Always the real file from `public/brand/`, never redrawn and never recoloured
 * in CSS: the white variant is the same artwork in a different fill, not a
 * filter over the orange one.
 *
 * The artwork is 3516.375 × 727.446 (≈ 4.83 : 1). Set a height and let the
 * width follow - `w-auto` is what stops it being squashed into a container.
 * The brand's practical heights: 22 in a dense toolbar, 24 in a sidebar, 28–30
 * in page chrome and on auth screens, 32 on a footer band. Clear space is at
 * least half the logo's height on every side.
 */
export function Logo({
    variant = 'orange',
    height = 24,
    className,
}: {
    /** `white` on orange and black surfaces; `orange` on white, sand and black. */
    variant?: 'orange' | 'white';
    /** In px. */
    height?: number;
    className?: string;
}) {
    return (
        <img
            src={variant === 'white' ? '/brand/affichez-logo-white.svg' : '/brand/affichez-logo.svg'}
            alt="Affichez"
            height={height}
            style={{ height }}
            className={cn('w-auto shrink-0', className)}
        />
    );
}

/**
 * The mark on its own - the ↗ z - for anywhere the wordmark cannot fit.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
    return (
        <img
            src="/brand/affichez-mark.svg"
            alt="Affichez"
            width={size}
            height={size}
            style={{ width: size, height: size }}
            className={cn('shrink-0', className)}
        />
    );
}
