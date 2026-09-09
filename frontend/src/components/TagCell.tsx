import { useState, useRef, useEffect } from 'react';
import { cn } from '../lib/utils';

/**
 * A table cell that shows a list of short values as badges.
 *
 * Used for Service and Source. Before this they were plain text, which read as
 * one run-on string when a company carried three services, and the overflow was
 * a bare "…" that gave no clue how much was hidden.
 *
 * Two rules:
 *
 * - **One badge, then "+N".** The first value is always readable in full; the
 *   count says exactly how many more there are, and hovering or clicking shows
 *   them. "…" told you something was missing but not whether it was one more or
 *   six.
 * - **Colour comes from the value, not from a palette order.** The same service
 *   is the same colour on every row and every page, because the colour is
 *   derived from the text. A list that re-colours itself when it is re-sorted is
 *   worse than no colour at all.
 */

const TONES = [
    'bg-blue-50 text-blue-700 ring-blue-100',
    'bg-violet-50 text-violet-700 ring-violet-100',
    'bg-emerald-50 text-emerald-700 ring-emerald-100',
    'bg-amber-50 text-amber-700 ring-amber-100',
    'bg-rose-50 text-rose-700 ring-rose-100',
    'bg-cyan-50 text-cyan-700 ring-cyan-100',
    'bg-indigo-50 text-indigo-700 ring-indigo-100',
    'bg-teal-50 text-teal-700 ring-teal-100',
] as const;

/** Stable hash → the same label always lands on the same tone. */
function toneFor(label: string): string {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0;
    return TONES[Math.abs(h) % TONES.length];
}

export function Tag({ label, muted, className }: {
    label: string;
    /** Rendered grey — used when the value was borrowed rather than recorded. */
    muted?: boolean;
    className?: string;
}) {
    return (
        <span
            translate="no"
            title={label}
            className={cn(
                // inline-block, not inline-flex: `truncate` needs a block
                // formatting context to clip, and as a flex container the text
                // node inside simply overflowed the cell instead of eliding.
                'inline-block max-w-[128px] truncate align-middle rounded-md px-1.5 py-0.5',
                'text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset',
                muted ? 'bg-slate-50 text-slate-400 ring-slate-100' : toneFor(label),
                className,
            )}
        >
            {label}
        </span>
    );
}

export function TagCell({ values, muted, emptyLabel = '—' }: {
    values: string[];
    /** Grey badges plus a marker, for a value inferred rather than recorded. */
    muted?: boolean;
    emptyLabel?: string;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLSpanElement>(null);

    // A pinned popover closes on Escape or a click elsewhere, like any other.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        const onClick = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onClick);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onClick);
        };
    }, [open]);

    const clean = (values ?? []).filter(v => v && v.trim() && v !== '-None-');
    if (clean.length === 0) return <span className="text-slate-300">{emptyLabel}</span>;

    const [first, ...rest] = clean;

    return (
        <span ref={ref} className="relative inline-flex items-center gap-1">
            <Tag label={first} muted={muted} />
            {rest.length > 0 && (
                <>
                    <button
                        type="button"
                        onMouseEnter={() => setOpen(true)}
                        onMouseLeave={() => setOpen(false)}
                        onFocus={() => setOpen(true)}
                        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
                        aria-label={`${rest.length} autre${rest.length > 1 ? 's' : ''}`}
                        className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold
                                   text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700"
                    >
                        <span translate="no">+{rest.length}</span>
                    </button>
                    {open && (
                        <span
                            role="tooltip"
                            // Stops a click inside the popover from opening the row.
                            onClick={e => e.stopPropagation()}
                            className="absolute left-0 top-6 z-30 flex max-w-[240px] flex-wrap gap-1
                                       rounded-xl border border-slate-100 bg-white p-2 shadow-card-hover"
                        >
                            {rest.map(v => <Tag key={v} label={v} muted={muted} />)}
                        </span>
                    )}
                </>
            )}
        </span>
    );
}
