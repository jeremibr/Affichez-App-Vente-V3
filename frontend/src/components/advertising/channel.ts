import type { AdAccountOption, AdChannel } from '../../types/database';

export const CHANNELS: AdChannel[] = ['google', 'meta'];

export const CHANNEL_LABEL: Record<AdChannel, string> = {
    google: 'Google Ads',
    meta: 'Meta Ads',
};

/**
 * The page has three views.
 *
 *   payant     ad spend compared with the accounts tagged Google Ads / Meta Ads;
 *   organique  the accounts that came through the same platforms without an ad,
 *              with no spend at all;
 *   inconnu    Google only: the accounts tagged "Google Organique" before that
 *              source was reserved for organic arrivals. Paid and organic cannot
 *              be told apart in them, so they are counted in neither view.
 *
 * Which accounts belong to which view is decided in SQL (ad_channel_source_map),
 * including the date that separates "inconnu" from "organique". Nothing here
 * repeats it.
 */
export type AdView = 'organique' | 'payant' | 'inconnu';

/** What every visit starts on. */
export const DEFAULT_AD_VIEW: AdView = 'organique';

export const AD_VIEWS: { value: AdView; label: string }[] = [
    { value: 'organique', label: 'Organique' },
    { value: 'payant',    label: 'Payant' },
    { value: 'inconnu',   label: 'Google inconnu' },
];

/** The `p_view` value of each view. */
export const AD_VIEW_PARAM: Record<AdView, 'organic' | 'paid' | 'unknown'> = {
    organique: 'organic',
    payant: 'paid',
    inconnu: 'unknown',
};

export function parseAdView(value: string): AdView {
    return AD_VIEWS.some(v => v.value === value) ? (value as AdView) : DEFAULT_AD_VIEW;
}

/** Only the paid view has a spend to show and to divide by. */
export function viewHasSpend(view: AdView): boolean {
    return view === 'payant';
}

/**
 * What a channel is called in each view. The organic words are the Zoho source
 * values themselves, so a card title and the "Origine" line under it read the
 * same.
 */
const CHANNEL_LABEL_BY_VIEW: Record<AdView, Record<AdChannel, string>> = {
    payant: CHANNEL_LABEL,
    organique: { google: 'Google Organique', meta: 'Meta Organique' },
    // Meta has no "inconnu" cohort; the label is only here to keep the map total.
    inconnu: { google: 'Google inconnu', meta: 'Meta' },
};

export function channelLabel(channel: AdChannel, view: AdView): string {
    return CHANNEL_LABEL_BY_VIEW[view][channel];
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

/** An ISO date as "1 oct. 2026". */
export function formatAdDay(iso: string | null): string {
    if (!iso) return '';
    return new Date(`${iso}T00:00:00`).toLocaleDateString('fr-CA', {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

/**
 * The creation-date range a channel's accounts are taken from, in words, or
 * null when the view counts them whatever their date.
 */
export function cohortBoundsLabel(from: string | null, before: string | null): string | null {
    if (from) return `comptes créés depuis le ${formatAdDay(from)}`;
    if (before) return `comptes créés avant le ${formatAdDay(before)}`;
    return null;
}

/** A Google customer id the way Google Ads prints it: 437-363-4595. */
export function formatAccountId(id: string): string {
    return /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

/** How a filter and a notice name an ad account: its name and its id, or the id alone. */
export function adAccountLabel(account: AdAccountOption): string {
    const id = formatAccountId(account.id);
    return account.name ? `${account.name} · ${id}` : id;
}

/**
 * The part of an ad-account selection that narrows anything. A platform with
 * every one of its accounts selected is not narrowed, so those accounts are left
 * out: ticking both Google accounts is the same request as ticking none. Ids
 * that are not on offer are dropped. Returned in the order of `choices`.
 */
export function narrowingAdAccounts(choices: AdAccountOption[], selectedIds: string[]): AdAccountOption[] {
    return choices.filter(a => selectedIds.includes(a.id)
        && choices.some(b => b.platform === a.platform && !selectedIds.includes(b.id)));
}

/**
 * Whether spend from `adAccountId` is counted under an ad-account selection.
 * A selection narrows only the platforms it names: picking one Google account
 * leaves Meta whole. `selected` is null when nothing is selected. This is the
 * rule p_ad_accounts follows in get_ad_performance and get_ad_monthly; the
 * campaign table applies it here because its rows already carry the account.
 */
export function inAdAccountSelection(
    platform: AdChannel,
    adAccountId: string,
    selected: AdAccountOption[] | null,
): boolean {
    if (selected === null) return true;
    const ofPlatform = selected.filter(a => a.platform === platform);
    return ofPlatform.length === 0 || ofPlatform.some(a => a.id === adAccountId);
}
