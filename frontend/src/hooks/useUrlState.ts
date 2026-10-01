import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Extra params to move in the same navigation as the one being set. `null`
 * removes a param.
 *
 * Needed because react-router's `setSearchParams` closes over the params of the
 * render that produced it, so two calls in one event handler both start from
 * that same snapshot and each fires its own navigate() - the second silently
 * discards the first. Every filter on the Leads detail page also reset `page`,
 * which meant the filter itself was the change being thrown away: the dropdown
 * snapped straight back and nothing could be selected at all.
 */
export type UrlStateCompanions = Record<string, string | null>;

/**
 * Syncs a string state value with a URL search param.
 * On reload the value is restored from the URL; on change the URL is updated (replace, no history entry).
 * When value === defaultValue the param is removed from the URL to keep it clean.
 */
export function useUrlState(
    key: string,
    defaultValue: string,
): [string, (value: string, also?: UrlStateCompanions) => void] {
    const [searchParams, setSearchParams] = useSearchParams();
    const value = searchParams.get(key) ?? defaultValue;

    const setValue = useCallback(
        (newValue: string, also?: UrlStateCompanions) => {
            setSearchParams(
                prev => {
                    const next = new URLSearchParams(prev);
                    if (newValue === defaultValue) next.delete(key);
                    else next.set(key, newValue);
                    applyCompanions(next, also);
                    return next;
                },
                { replace: true },
            );
        },
        [key, defaultValue, setSearchParams],
    );

    return [value, setValue];
}

function applyCompanions(params: URLSearchParams, also?: UrlStateCompanions): void {
    if (!also) return;
    for (const [key, value] of Object.entries(also)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
    }
}

/**
 * The "everything" words the single-value filters used to put in the URL. A
 * link saved before the filters took several values can still carry one, and it
 * means what it always meant: no filter.
 */
const ALL_WORDS: readonly string[] = ['Tous', 'Toutes'];

/**
 * A list of values in the URL, for a filter that takes several.
 *
 * Written as a repeated param (`?rep=A&rep=B`), not a joined string: the values
 * are free text from Zoho and can contain any separator one could pick. A link
 * made when the filter held one value (`?rep=A`) reads as a list of one.
 *
 * An empty list removes the param, and means "no filter".
 *
 * The array keeps its identity while the URL holds the same values, so it is
 * safe as a hook dependency.
 */
export function useUrlList(
    key: string,
): [string[], (values: string[], also?: UrlStateCompanions) => void] {
    const [searchParams, setSearchParams] = useSearchParams();
    // NUL cannot occur in a URL value, so the joined string is a faithful key.
    const raw = searchParams.getAll(key).filter(v => v !== '' && !ALL_WORDS.includes(v)).join('\0');
    const values = useMemo(() => (raw === '' ? [] : raw.split('\0')), [raw]);

    const setValues = useCallback(
        (newValues: string[], also?: UrlStateCompanions) => {
            setSearchParams(
                prev => {
                    const next = new URLSearchParams(prev);
                    next.delete(key);
                    for (const v of newValues) next.append(key, v);
                    applyCompanions(next, also);
                    return next;
                },
                { replace: true },
            );
        },
        [key, setSearchParams],
    );

    return [values, setValues];
}

/**
 * Same as useUrlState but for number values.
 */
export function useUrlStateNumber(
    key: string,
    defaultValue: number,
): [number, (value: number, also?: UrlStateCompanions) => void] {
    const [searchParams, setSearchParams] = useSearchParams();
    const raw = searchParams.get(key);
    const value = raw !== null && raw !== '' && !isNaN(Number(raw)) ? Number(raw) : defaultValue;

    const setValue = useCallback(
        (newValue: number, also?: UrlStateCompanions) => {
            setSearchParams(
                prev => {
                    const next = new URLSearchParams(prev);
                    if (newValue === defaultValue) next.delete(key);
                    else next.set(key, String(newValue));
                    applyCompanions(next, also);
                    return next;
                },
                { replace: true },
            );
        },
        [key, defaultValue, setSearchParams],
    );

    return [value, setValue];
}
