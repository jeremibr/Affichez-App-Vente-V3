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

/**
 * Ten tones, in two weights.
 *
 * The first eight were eight *light* pastels, and two complaints came straight
 * back: violet and indigo read as the same purple, and Cold-call and Internet
 * were indistinguishable in the Source column. There simply are not eight
 * pastels a person can tell apart at 10px.
 *
 * So neighbouring hues are separated by weight as well as by hue — where two
 * hues sit close on the wheel, one of them is always the deeper fill. Light
 * blue against deep cyan, light amber against deep orange, light violet against
 * deep fuchsia and deep indigo: different at a glance, not on inspection.
 */
const TONES = [
    // Pale.
    'bg-emerald-50 text-emerald-700 ring-emerald-200',   // 0
    'bg-blue-50 text-blue-700 ring-blue-200',            // 1
    'bg-amber-50 text-amber-800 ring-amber-200',         // 2
    'bg-violet-50 text-violet-700 ring-violet-200',      // 3
    'bg-rose-50 text-rose-700 ring-rose-200',            // 4
    // Saturated. A pale badge and a deep one are never mistaken for each other
    // even when the hues are neighbours — which is what the first attempt at
    // this palette, eight pale tones, got wrong.
    'bg-cyan-200 text-cyan-900 ring-cyan-400',           // 5
    'bg-lime-200 text-lime-900 ring-lime-400',           // 6
    'bg-orange-200 text-orange-900 ring-orange-400',     // 7
    'bg-fuchsia-200 text-fuchsia-900 ring-fuchsia-400',  // 8
    'bg-indigo-200 text-indigo-900 ring-indigo-400',     // 9
] as const;

/**
 * Stable hash → the same label always lands on the same tone, on every row and
 * every page, because a list that re-colours itself when it is re-sorted is
 * worse than no colour at all.
 *
 * The key is normalised, so Zoho's two spellings of "Distribution Publicitaire"
 * are one colour rather than two.
 *
 * The two constants are not arbitrary. Ten tones against ~45 distinct labels
 * means collisions cannot be ruled out — fourteen sources into ten tones forces
 * at least four. So the pair was chosen by search: the one that spreads the
 * labels this app actually holds (the 14 commonest sources, the 8 services, the
 * 7 invoice departments) across the most tones, weighted by how many accounts
 * carry each label. The eight commonest sources and all eight services come out
 * on distinct tones; what still shares one is the tail — Client PLOGG/BUCCO
 * with Meta Ads, Facebook with Publicité/Recherche Google, and two more under
 * 100 accounts each. Re-run scratchpad/tune_tone_hash.py if the picklists move.
 */
const TONE_HASH_MULTIPLIER = 54677;
const TONE_HASH_SEED = 251886;

function toneKey(label: string): string {
    return label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function toneFor(label: string): string {
    const k = toneKey(label);
    let h = TONE_HASH_SEED;
    for (let i = 0; i < k.length; i++) h = (h * TONE_HASH_MULTIPLIER + k.charCodeAt(i)) | 0;
    return TONES[Math.abs(h) % TONES.length];
}

export function Tag({ label, muted, full, className }: {
    label: string;
    /** Rendered grey — used when the value was borrowed rather than recorded. */
    muted?: boolean;
    /** Show the whole label, wrapping if it must. For the overflow panel, where
     *  there is room and the entire point is reading the names in full. */
    full?: boolean;
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
                'inline-block align-middle rounded-md px-1.5 py-0.5',
                full ? 'max-w-full whitespace-normal break-words' : 'max-w-[128px] truncate',
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
                            // Wide enough for the longest service Zoho holds
                            // ("Imprimés, articles et vêtements promo"), one per
                            // line. The old 240px panel clipped every badge in
                            // it to "DISTRIBUTION PUBL…", which is the one thing
                            // the panel exists to avoid.
                            className="absolute left-0 top-6 z-30 flex w-max min-w-[180px] max-w-[320px] flex-col items-start gap-1
                                       rounded-xl border border-slate-100 bg-white p-2 shadow-card-hover"
                        >
                            {rest.map(v => <Tag key={v} label={v} muted={muted} full />)}
                        </span>
                    )}
                </>
            )}
        </span>
    );
}
