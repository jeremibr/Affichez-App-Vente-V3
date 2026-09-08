import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../lib/utils';

interface Props {
    /** What the figure actually measures. Plain sentences, no markup. */
    text: string;
    className?: string;
}

/**
 * A small "what is this number?" marker next to a KPI or a table heading.
 *
 * Opens on hover and on focus, and stays open on click — several of these
 * explanations run to a few lines, which is longer than a hover tooltip is
 * comfortable to read, and a touch screen has no hover at all.
 */
export function InfoHint({ text, className }: Props) {
    const [open, setOpen] = useState(false);
    const [pinned, setPinned] = useState(false);
    const id = useId();
    const wrapRef = useRef<HTMLSpanElement>(null);

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

    const visible = open || pinned;

    return (
        <span ref={wrapRef} className={cn('relative inline-flex', className)}>
            <button
                type="button"
                aria-label="À propos de cette donnée"
                aria-expanded={visible}
                aria-describedby={visible ? id : undefined}
                onMouseEnter={() => setOpen(true)}
                onMouseLeave={() => setOpen(false)}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onClick={() => setPinned(p => !p)}
                className="text-slate-300 transition-colors hover:text-brand-main focus:text-brand-main
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-main/40 rounded-full"
            >
                <Info className="h-3.5 w-3.5" />
            </button>

            {visible && (
                <span
                    id={id}
                    role="tooltip"
                    // right-0 so a card at the right edge of the grid does not push
                    // the panel off screen.
                    //
                    // whitespace-normal / normal-case / tracking-normal undo what
                    // the panel inherits when the hint sits in a table heading:
                    // `.th` is uppercase, wide-tracked and nowrap, and nowrap in
                    // particular stopped the text wrapping inside w-64, so it ran
                    // off the right of the screen as one clipped line.
                    className="absolute right-0 top-6 z-30 w-64 rounded-xl border border-slate-100
                               bg-white p-3 text-left text-[11px] font-medium not-italic leading-relaxed
                               normal-case tracking-normal whitespace-normal
                               text-slate-500 shadow-card-hover"
                >
                    {text}
                </span>
            )}
        </span>
    );
}
