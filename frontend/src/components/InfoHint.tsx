import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { cn } from '../lib/utils';

interface Props {
    /** What the figure actually measures. Plain sentences, no markup. */
    text: string;
    className?: string;
}

/** Panel width in px - used to decide which side it hangs from. */
const PANEL_W = 256;

/**
 * A small "what is this number?" marker next to a KPI or a table heading.
 *
 * Opens on hover and on focus, and stays open on click - several of these
 * explanations run to a few lines, which is longer than a hover tooltip is
 * comfortable to read, and a touch screen has no hover at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PANEL IS RENDERED IN A PORTAL
 *
 * It used to be a normal absolutely-positioned child, and it kept getting cut
 * off - three separate reports. Absolute positioning cannot escape an ancestor,
 * and these markers sit inside two things that trap it:
 *
 *   - table headings, whose `.th` is `white-space: nowrap` (so the text could
 *     not even wrap inside its own box and ran off the screen), and
 *   - the breakdown cards, which are `overflow-hidden` to clip their rounded-xs
 *     corners - and clipped the panel along with them.
 *
 * A portal to <body> with fixed positioning has no ancestor to be clipped by, no
 * inherited text rules, and no stacking-context surprises. The position is
 * measured from the marker each time it opens.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function InfoHint({ text, className }: Props) {
    const [open, setOpen] = useState(false);
    const [pinned, setPinned] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const id = useId();
    const wrapRef = useRef<HTMLSpanElement>(null);

    const visible = open || pinned;

    // A pinned hint closes on Escape or on a click elsewhere, like any popover.
    useEffect(() => {
        if (!pinned) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { setPinned(false); setOpen(false); }
        };
        const onClick = (e: MouseEvent) => {
            if (!wrapRef.current?.contains(e.target as Node)) {
                setPinned(false);
                setOpen(false);
            }
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onClick);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onClick);
        };
    }, [pinned]);

    // Fixed coordinates follow the viewport, so a scroll while pinned would leave
    // the panel behind. Cheaper to close it than to track the marker.
    useEffect(() => {
        if (!visible) return;
        const close = () => { setOpen(false); setPinned(false); };
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [visible]);

    /**
     * Where to put the panel, measured from the marker at open time.
     *
     * Right-aligned by default so a marker near the right edge stays on screen,
     * flipped when there is not room to the left - and finally clamped, so it
     * cannot leave the viewport in either direction whatever the layout does.
     */
    const measure = () => {
        const r = wrapRef.current?.getBoundingClientRect();
        if (!r) return;
        const preferred = r.right - PANEL_W;          // right-aligned to the marker
        const left = Math.min(
            Math.max(8, preferred < 8 ? r.left : preferred),
            window.innerWidth - PANEL_W - 8,
        );
        setPos({ top: r.bottom + 6, left });
    };

    return (
        <span ref={wrapRef} className={cn('relative inline-flex', className)}>
            <button
                type="button"
                aria-label="À propos de cette donnée"
                aria-expanded={visible}
                aria-describedby={visible ? id : undefined}
                onMouseEnter={() => { measure(); setOpen(true); }}
                onMouseLeave={() => setOpen(false)}
                onFocus={() => { measure(); setOpen(true); }}
                onBlur={() => setOpen(false)}
                onClick={e => { e.stopPropagation(); measure(); setPinned(p => !p); }}
                className="text-ink-faint transition-colors hover:text-primary-press focus:text-primary-press
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-full"
            >
                <Info className="h-3.5 w-3.5" />
            </button>

            {visible && pos && createPortal(
                <span
                    id={id}
                    role="tooltip"
                    style={{ top: pos.top, left: pos.left, width: PANEL_W }}
                    // normal-case / tracking-normal / whitespace-normal undo what a
                    // table heading would otherwise impose - though inside the
                    // portal nothing inherits them any more, they are kept so the
                    // panel is immune to wherever it is mounted next.
                    className="fixed z-[100] rounded-lg border border-hairline bg-white p-3
                               text-left text-2xs font-medium not-italic leading-relaxed
                               normal-case tracking-normal whitespace-normal
                               text-ink-mute shadow-elevated"
                >
                    {text}
                </span>,
                document.body,
            )}
        </span>
    );
}
