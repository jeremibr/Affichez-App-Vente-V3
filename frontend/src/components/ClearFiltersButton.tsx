import { FilterX } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * "Réinitialiser" - puts every filter on the page back to its default.
 *
 * Two things about it that are not obvious:
 *
 * **It shows how many filters are active.** With nine dropdowns on one bar, a
 * page returning almost nothing is usually a filter somebody forgot about, three
 * rows further along. The count is the fastest way to see that without reading
 * every control.
 *
 * **It is disabled rather than hidden when nothing is active.** The filter bar is
 * a wrapping flex row, so a control that appears and disappears reflows the whole
 * bar and moves the dropdown you were about to click.
 *
 * The caller owns the reset, because it has to happen in ONE navigation: each URL
 * setter closes over the address bar as it was when that render produced it, so
 * clearing nine params with nine calls would leave eight of them behind. Every
 * caller passes a single setter carrying the rest as companions - the same rule
 * the filters themselves follow. See UrlStateCompanions in hooks/useUrlState.
 */
export function ClearFiltersButton({ activeCount, onClear, className }: {
    /** How many filters differ from their default. 0 disables the button. */
    activeCount: number;
    onClear: () => void;
    className?: string;
}) {
    const active = activeCount > 0;
    return (
        <button
            type="button"
            onClick={onClear}
            disabled={!active}
            title={active
                ? `Remettre les ${activeCount} filtre${activeCount > 1 ? 's' : ''} actif${activeCount > 1 ? 's' : ''} à leur valeur par défaut`
                : 'Aucun filtre actif'}
            // `btn-sm` is 36px - the same height as the Select triggers beside
            // it. The hand-set 38px it used to carry left it 2px proud of them.
            className={cn(
                'btn btn-sm text-xs gap-1.5',
                // Not `.btn-quiet`: this one is already *on* when filters are
                // active, so it wears the tint instead of waiting for a hover.
                active
                    ? 'border border-primary/40 text-primary-press bg-primary-wash hover:border-primary'
                    : 'border border-hairline-strong text-ink-faint bg-white cursor-not-allowed',
                className,
            )}
        >
            <FilterX className="w-3.5 h-3.5" />
            Réinitialiser
            {active && (
                <span
                    translate="no"
                    className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1
                               rounded-full bg-primary text-white text-2xs font-bold tabular-nums"
                >
                    {activeCount}
                </span>
            )}
        </button>
    );
}
