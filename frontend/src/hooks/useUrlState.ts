import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Syncs a string state value with a URL search param.
 * On reload the value is restored from the URL; on change the URL is updated (replace, no history entry).
 * When value === defaultValue the param is removed from the URL to keep it clean.
 */
export function useUrlState(
    key: string,
    defaultValue: string,
): [string, (value: string) => void] {
    const [searchParams, setSearchParams] = useSearchParams();
    const value = searchParams.get(key) ?? defaultValue;

    const setValue = useCallback(
        (newValue: string) => {
            setSearchParams(
                prev => {
                    const next = new URLSearchParams(prev);
                    if (newValue === defaultValue) next.delete(key);
                    else next.set(key, newValue);
                    return next;
                },
                { replace: true },
            );
        },
        [key, defaultValue, setSearchParams],
    );

    return [value, setValue];
}

/**
 * Same as useUrlState but for number values.
 */
export function useUrlStateNumber(
    key: string,
    defaultValue: number,
): [number, (value: number) => void] {
    const [searchParams, setSearchParams] = useSearchParams();
    const raw = searchParams.get(key);
    const value = raw !== null && raw !== '' && !isNaN(Number(raw)) ? Number(raw) : defaultValue;

    const setValue = useCallback(
        (newValue: number) => {
            setSearchParams(
                prev => {
                    const next = new URLSearchParams(prev);
                    if (newValue === defaultValue) next.delete(key);
                    else next.set(key, String(newValue));
                    return next;
                },
                { replace: true },
            );
        },
        [key, defaultValue, setSearchParams],
    );

    return [value, setValue];
}
