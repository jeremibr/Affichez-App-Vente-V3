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
 * blue against deep violet, light amber against deep gold, deep fuchsia
 * against deep indigo: different at a glance, not on inspection.
 *
 * These are the DATA palette (see src/index.css), not brand colours, and that
 * is deliberate: orange means action and the status tones mean status, so
 * neither can be spent on colouring forty-five picklist values.
 *
 * Tone 7 used to be a deep ORANGE. The 2026 brand made #F5570E the action
 * colour, and a deep-orange badge sitting in a table read as a button. It was
 * swapped for a deep gold on 2026-09-14 — the same slot, the same weight, the
 * same warm half of the wheel, just far enough from the brand orange to stop
 * competing with it.
 *
 * Tone 3 (violet) was a PALE fill until 2026-09-14, which made it a near-white
 * twin of tone 1 (blue) — Cold-call and Meta Ads sitting one above the other in
 * the Source column with nothing but the ink between them. It is now a solid
 * lavender. Same hue, same slot, deeper weight: exactly the rule above. The
 * numbers are in src/index.css.
 *
 * Neither the slot COUNT nor the ORDER changed, and neither did the two hash
 * constants below, because they were tuned against the real distribution of
 * labels in this database. Dropping a tone would have re-shuffled every label
 * onto a new colour and there is no way to re-run that search from the code
 * alone — the picklists live in Zoho. So every label still lands on the slot it
 * always did; two of those slots simply look different now.
 */
const TONES = [
    // Pale.
    'bg-data-1 text-data-1-ink ring-data-1-edge',        // 0  green
    'bg-data-2 text-data-2-ink ring-data-2-edge',        // 1  blue
    'bg-data-3 text-data-3-ink ring-data-3-edge',        // 2  amber
    'bg-data-4 text-data-4-ink ring-data-4-edge',        // 3  violet — a DEEP
                                                        //    fill despite its
                                                        //    place in this run
    'bg-data-5 text-data-5-ink ring-data-5-edge',        // 4  rose
    // Saturated. A pale badge and a deep one are never mistaken for each other
    // even when the hues are neighbours — which is what the first attempt at
    // this palette, eight pale tones, got wrong.
    'bg-data-6 text-data-6-ink ring-data-6-edge',        // 5  cyan
    'bg-data-7 text-data-7-ink ring-data-7-edge',        // 6  lime
    'bg-data-8 text-data-8-ink ring-data-8-edge',        // 7  gold  (was orange)
    'bg-data-9 text-data-9-ink ring-data-9-edge',        // 8  fuchsia
    'bg-data-10 text-data-10-ink ring-data-10-edge',     // 9  indigo
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
                'text-2xs font-semibold uppercase tracking-wide ring-1 ring-inset',
                muted ? 'bg-sand text-ink-mute ring-hairline' : toneFor(label),
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
    if (clean.length === 0) return <span className="text-ink-faint">{emptyLabel}</span>;

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
                        className="rounded-md bg-stone px-1.5 py-0.5 text-2xs font-bold
                                   text-ink-secondary transition-colors hover:bg-hairline-strong hover:text-ink"
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
                                       rounded-lg border border-hairline bg-white p-2 shadow-elevated"
                        >
                            {rest.map(v => <Tag key={v} label={v} muted={muted} full />)}
                        </span>
                    )}
                </>
            )}
        </span>
    );
}
