import type { AdChannel } from '../../types/database';

export const CHANNELS: AdChannel[] = ['google', 'meta'];

export const CHANNEL_LABEL: Record<AdChannel, string> = {
    google: 'Google Ads',
    meta: 'Meta Ads',
};

/** Categorical colour per channel, from the data palette (not brand or status tones). */
export const CHANNEL_TONE: Record<AdChannel, { ink: string }> = {
    google: { ink: 'var(--color-data-2-ink)' },
    meta:   { ink: 'var(--color-data-4-ink)' },
};

/**
 * True while the period's attribution window is still open, i.e. its accounts
 * can still be invoiced and its revenue and return are not final.
 * `null` means an uncapped window, which has nothing left to wait for.
 */
export function isCohortOpen(windowEndsOn: string | null): boolean {
    if (!windowEndsOn) return false;
    return new Date(`${windowEndsOn}T00:00:00`) > new Date();
}

/** Return on spend as "1 $ → 4,20 $". */
export function formatReturn(roas: number): string {
    return `1 $ → ${roas.toLocaleString('fr-CA', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
    })} $`;
}
