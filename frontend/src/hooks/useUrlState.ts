import { useCallback } from 'react';
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
