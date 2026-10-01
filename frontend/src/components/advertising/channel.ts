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

/** Organic counterpart of each channel: the same platform, no ad behind it. */
export const CHANNEL_LABEL_ORGANIC: Record<AdChannel, string> = {
    google: 'Recherche Google',
    meta: 'Facebook',
};

export function channelLabel(channel: AdChannel, organic: boolean): string {
    return organic ? CHANNEL_LABEL_ORGANIC[channel] : CHANNEL_LABEL[channel];
}

/**
 * What each organic origin meant before it became organic-only. Shown on the
 * organic cards so an old cohort is not read as ad-free.
 */
export const ORGANIC_CAVEAT: Record<AdChannel, string> = {
    google: 'Avant le 29 septembre 2026, « Publicité/Recherche Google » servait aussi aux clics sur une pub Google. Les comptes d’avant cette date mélangent recherche et publicité, sauf les 35 reconnus par leur identifiant de clic, déplacés sous « Google Ads ».',
    meta: 'Avant l’arrivée de « Meta Ads » en août 2024, un client venu d’une publicité Facebook pouvait être classé « Facebook ». Les comptes d’avant cette date peuvent mélanger page et publicité.',
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
