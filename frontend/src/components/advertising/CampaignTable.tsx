import { useMemo } from 'react';
import type { AdCampaignRow, AdCampaignStatus } from '../../types/database';
import { formatCurrencyCAD, formatShortDate, cn } from '../../lib/utils';
import { InfoHint } from '../InfoHint';
import { ExportButton } from '../ExportButton';
import { Select } from '../Select';
import type { CsvColumn } from '../../lib/csv';
import { useSort, type SortConfig } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';
import { CHANNEL_LABEL, CHANNELS } from './channel';
import { ChannelLogo } from './ChannelLogo';

const STATUS_LABEL: Record<AdCampaignStatus, string> = {
    active: 'Active',
    paused: 'En pause',
    removed: 'Supprimée',
    unknown: 'Statut inconnu',
};

/** Status is a state, so it uses the tone palette, never the brand orange. */
const STATUS_CLASS: Record<AdCampaignStatus, string> = {
    active: 'bg-tone-good-soft text-tone-good-ink',
    paused: 'bg-tone-warn-soft text-tone-warn-ink',
    removed: 'bg-tone-neutral-soft text-tone-neutral-ink',
    unknown: 'bg-tone-neutral-soft text-tone-neutral-ink',
};

const CAMPAIGN_STATUS_FILTERS = ['Tous', 'active', 'paused', 'removed'] as const;

const FILTER_LABEL: Record<(typeof CAMPAIGN_STATUS_FILTERS)[number], string> = {
    Tous: 'Tous les statuts',
    active: 'Actives',
    paused: 'En pause',
    removed: 'Supprimées',
};

/**
 * Per-campaign figures as reported by the ad platforms, filterable by platform and
 * current status. There is no revenue column: CRM accounts cannot be traced back
 * to a campaign.
 */
export function CampaignTable({ rows, platform, onPlatformChange, status, onStatusChange }: {
    rows: AdCampaignRow[];
    platform: string;
    onPlatformChange: (v: string) => void;
    status: string;
    onStatusChange: (v: string) => void;
}) {
    const byPlatform = useMemo(
        () => (platform === 'Toutes' ? rows : rows.filter(r => r.platform === platform)),
        [rows, platform],
    );
    const counts = useMemo(() => {
        const c: Record<string, number> = { Tous: byPlatform.length, active: 0, paused: 0, removed: 0 };
        for (const r of byPlatform) if (r.status in c) c[r.status]++;
        return c;
    }, [byPlatform]);
    const visible = useMemo(
        () => (status === 'Tous' ? byPlatform : byPlatform.filter(r => r.status === status)),
        [byPlatform, status],
    );
    const { sortedData, sortConfig, handleSort } = useSort(visible, 'spend', 'desc');
    const total = visible.reduce((sum, r) => sum + Number(r.spend), 0);

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">Campagnes</h3>
                <InfoHint text="Chiffres des plateformes publicitaires uniquement : dépense, impressions, clics et conversions telles que Google Ads et Meta les rapportent, sur la période choisie. Le statut est celui de la campagne aujourd'hui. Aucune colonne de revenus : le CRM ne conserve aucun identifiant de clic, un compte ne peut donc pas être rattaché à une campagne." />
                <div className="ml-auto flex flex-wrap items-center gap-2 md:gap-3">
                    <Select
                        value={status}
                        onChange={onStatusChange}
                        className="w-44"
                        options={CAMPAIGN_STATUS_FILTERS.map(s => ({
                            value: s,
                            label: `${FILTER_LABEL[s]} (${counts[s] ?? 0})`,
                        }))}
                    />
                    <Select
                        value={platform}
                        onChange={onPlatformChange}
                        className="w-40"
                        options={[
                            { value: 'Toutes', label: 'Les deux canaux' },
                            ...CHANNELS.map(c => ({
                                value: c,
                                label: CHANNEL_LABEL[c],
                                icon: <ChannelLogo channel={c} size="xs" />,
                            })),
                        ]}
                    />
                    <ExportButton rows={sortedData} columns={CSV} filename="publicite_campagnes"
                                  disabled={visible.length === 0} />
                </div>
            </div>

            {visible.length === 0 ? (
                <p className="px-5 py-10 text-sm text-ink-mute text-center">
                    Aucune campagne pour ces filtres sur la période choisie.
                </p>
            ) : (
                <div className="overflow-x-auto max-h-[520px]">
                    <table className="w-full text-sm" translate="no">
                        <thead className="sticky top-0 bg-sand/95 backdrop-blur z-10">
                            <tr className="border-b border-hairline">
                                <Th label="Campagne"     k="campaign_name" align="left" {...{ sortConfig, handleSort }} />
                                <Th label="Période"      k="first_date"    align="left" {...{ sortConfig, handleSort }} />
                                <Th label="Dépense"      k="spend"         {...{ sortConfig, handleSort }} />
                                <Th label="Impressions"  k="impressions"   {...{ sortConfig, handleSort }} />
                                <Th label="Clics"        k="clicks"        {...{ sortConfig, handleSort }} />
                                <Th label="CPC"          k="cpc"           {...{ sortConfig, handleSort }} />
                                <Th label="CPM"          k="cpm"           {...{ sortConfig, handleSort }} />
                                <Th label="Conv."        k="conversions"   {...{ sortConfig, handleSort }} />
                                <Th label="Coût / conv." k="cost_per_conv" {...{ sortConfig, handleSort }} />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline">
                            {sortedData.map(r => (
                                <tr key={`${r.platform}-${r.ad_account_id}-${r.campaign_id}`}
                                    className="hover:bg-sand/60 transition-colors">
                                    <td className="px-4 py-2.5">
                                        <p className="font-semibold text-ink-secondary text-xs truncate max-w-[380px] flex items-center gap-1.5"
                                           title={r.campaign_name ?? r.campaign_id}>
                                            <ChannelLogo channel={r.platform} size="xs" />
                                            {r.campaign_name ?? `Campagne ${r.campaign_id}`}
                                        </p>
                                        <p className="text-2xs text-ink-faint mt-1 pl-5 flex items-center gap-1.5">
                                            <span className={cn('px-1.5 py-px rounded-full font-semibold', STATUS_CLASS[r.status])}
                                                  title={r.platform_status ?? undefined}>
                                                {STATUS_LABEL[r.status]}
                                            </span>
                                            {CHANNEL_LABEL[r.platform]}
                                            {r.currency && r.currency !== 'CAD' && (
                                                <span className="font-bold text-tone-critical-ink">· {r.currency}</span>
                                            )}
                                        </p>
                                    </td>
                                    <td className="px-4 py-2.5 text-xs text-ink-secondary whitespace-nowrap tabular-nums">
                                        {r.first_date && r.last_date ? (
                                            r.first_date === r.last_date
                                                ? formatShortDate(r.first_date)
                                                : <>{formatShortDate(r.first_date)} <span className="text-ink-faint">→</span> {formatShortDate(r.last_date)}</>
                                        ) : '—'}
                                    </td>
                                    <Num v={formatCurrencyCAD(Number(r.spend))} strong />
                                    <Num v={Number(r.impressions).toLocaleString('fr-CA')} />
                                    <Num v={Number(r.clicks).toLocaleString('fr-CA')} />
                                    <Num v={r.cpc !== null ? formatCurrencyCAD(Number(r.cpc)) : '—'} />
                                    <Num v={r.cpm !== null ? formatCurrencyCAD(Number(r.cpm)) : '—'} />
                                    <Num v={Number(r.conversions).toLocaleString('fr-CA', { maximumFractionDigits: 1 })} />
                                    <Num v={r.cost_per_conv !== null ? formatCurrencyCAD(Number(r.cost_per_conv)) : '—'} />
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className="sticky bottom-0">
                            <tr className="bg-black text-white">
                                <td className="px-4 py-2.5 text-xs font-semibold" colSpan={2}>
                                    Total · {visible.length} campagne{visible.length > 1 ? 's' : ''}
                                </td>
                                <td className="px-4 py-2.5 text-right text-xs font-bold tabular-nums">
                                    {formatCurrencyCAD(total)}
                                </td>
                                <td colSpan={6} />
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}
        </div>
    );
}

function Th({ label, k, align = 'right', sortConfig, handleSort }: {
    label: string;
    k: keyof AdCampaignRow;
    align?: 'left' | 'right';
    sortConfig: SortConfig<AdCampaignRow>;
    handleSort: (k: keyof AdCampaignRow) => void;
}) {
    return (
        <th className={cn('px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap',
                          align === 'left' ? 'text-left' : 'text-right')}>
            <button type="button" onClick={() => handleSort(k)}
                    className={cn('group inline-flex items-center gap-1 uppercase tracking-eyebrow hover:text-ink transition-colors',
                                  align === 'right' && 'flex-row-reverse')}>
                {label}
                <SortIcon order={sortConfig.key === k ? sortConfig.order : null} />
            </button>
        </th>
    );
}

function Num({ v, strong }: { v: string; strong?: boolean }) {
    return (
        <td className={cn('px-4 py-2.5 text-right tabular-nums text-xs',
                          strong ? 'font-bold text-ink' : 'font-semibold text-ink-secondary')}>
            {v}
        </td>
    );
}

const round2 = (n: number | null) => (n === null ? null : Math.round(Number(n) * 100) / 100);

const CSV: CsvColumn<AdCampaignRow>[] = [
    { header: 'Canal',          value: r => CHANNEL_LABEL[r.platform] },
    { header: 'Compte pub',     value: r => r.ad_account_id },
    { header: 'Campagne',       value: r => r.campaign_name ?? r.campaign_id },
    { header: 'Statut',         value: r => STATUS_LABEL[r.status] },
    { header: 'Première dépense', value: r => r.first_date },
    { header: 'Dernière dépense', value: r => r.last_date },
    { header: 'Devise',         value: r => r.currency },
    { header: 'Dépense',        value: r => round2(r.spend) },
    { header: 'Impressions',    value: r => r.impressions },
    { header: 'Clics',          value: r => r.clicks },
    { header: 'CPC',            value: r => r.cpc },
    { header: 'CPM',            value: r => r.cpm },
    { header: 'Conversions',    value: r => r.conversions },
    { header: 'Coût par conv.', value: r => r.cost_per_conv },
];
