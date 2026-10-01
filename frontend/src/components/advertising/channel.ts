import type { AdChannel } from '../../types/database';

export const CHANNELS: AdChannel[] = ['google', 'meta'];

export const CHANNEL_LABEL: Record<AdChannel, string> = {
    google: 'Google Ads',
    meta: 'Meta Ads',
};

/**
 * The page has two views. "payant" compares ad spend with the accounts tagged
 * Google Ads / Meta Ads; "organique" shows the accounts that came through the
 * same platforms without an ad, with no spend at all.
 */
export type AdView = 'organique' | 'payant';

/**
 * Organic counterpart of each channel: the same platform, no ad behind it.
 * The words are the Zoho source values themselves, so a card title and the
 * "Origine" line under it read the same.
 */
export const CHANNEL_LABEL_ORGANIC: Record<AdChannel, string> = {
    google: 'Google Organique',
    meta: 'Meta Organique',
};

export function channelLabel(channel: AdChannel, organic: boolean): string {
    return organic ? CHANNEL_LABEL_ORGANIC[channel] : CHANNEL_LABEL[channel];
}

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
