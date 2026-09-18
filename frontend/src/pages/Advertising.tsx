import { useEffect, useState, useCallback, useMemo } from 'react';
import { useUrlState } from '../hooks/useUrlState';
import { cachedRpc } from '../lib/rpcCache';
import {
    Loader2, AlertTriangle, TriangleAlert, Settings2,
} from 'lucide-react';
import type {
    AdPerformanceRow, AdMonthlyRow, AdCampaignRow, AdSpendStatusRow, AdChannel,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { InfoHint } from '../components/InfoHint';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { ChannelCard } from '../components/advertising/ChannelCard';
import { SpendVsRevenueChart } from '../components/advertising/SpendVsRevenueChart';
import { CampaignTable } from '../components/advertising/CampaignTable';
import { CHANNEL_LABEL, isCohortOpen } from '../components/advertising/channel';
import { ChannelLogo, ChannelLogoTile } from '../components/advertising/ChannelLogo';
import { AdvertisingIcon } from '../components/advertising/AdvertisingIcon';

/**
 * Publicité: Google Ads and Meta spend compared with the revenue of the CRM
 * accounts attributed to each channel.
 *
 * Attribution is by channel and by month of account creation. Revenue for a
 * period keeps accruing until its attribution window closes, so figures from an
 * open window are marked as provisional (see isCohortOpen).
 */

const DEFAULT_EXCLUDED_RATINGS = ['Compte interne : Ne pas reprendre', 'Fournisseur'];

const WINDOW_OPTIONS = [
    { value: '3',     label: '3 mois après' },
    { value: '6',     label: '6 mois après' },
    { value: '12',    label: '12 mois après' },
    { value: '24',    label: '24 mois après' },
    { value: 'Toute', label: 'Tout l’historique' },
];

const CURRENT_YEAR = new Date().getFullYear();

const YEAR_OPTIONS = [
    { value: 'Toutes', label: 'Toutes les années' },
    ...Array.from({ length: CURRENT_YEAR - 2020 }, (_, i) => CURRENT_YEAR - i)
        .map(y => ({ value: String(y), label: String(y) })),
];

export default function Advertising() {
    const [yearParam, setYearParam] = useUrlState('year', String(CURRENT_YEAR));
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);

    const [monthParam, setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = monthParam === 'Toutes' ? 'Toutes' : Number(monthParam);

    const [windowParam, setWindowParam] = useUrlState('fenetre', '12');
    const [ratingScope, setRatingScope] = useUrlState('statut', 'Clients');
    const [campaignPlatform, setCampaignPlatform] = useUrlState('plateforme', 'Toutes');
    const [campaignStatus, setCampaignStatus] = useUrlState('campagnes', 'Tous');

    const [loading, setLoading] = useState(true);
    const [perf, setPerf] = useState<AdPerformanceRow[]>([]);
    const [monthly, setMonthly] = useState<AdMonthlyRow[]>([]);
    const [campaigns, setCampaigns] = useState<AdCampaignRow[]>([]);
    const [status, setStatus] = useState<AdSpendStatusRow[]>([]);

    const yearValue = year === 'Toutes' ? null : year;
    // A month only applies within a year.
    const monthValue = selectedMonth === 'Toutes' || yearValue === null ? null : selectedMonth;
    const windowMonths = windowParam === 'Toute' ? null : Number(windowParam);
    const excludeRatings = ratingScope === 'Tous' ? null : DEFAULT_EXCLUDED_RATINGS;

    const activeFilterCount = [
        yearParam !== String(CURRENT_YEAR),
        monthParam !== 'Toutes',
        windowParam !== '12',
        ratingScope !== 'Clients',
        campaignPlatform !== 'Toutes',
        campaignStatus !== 'Tous',
    ].filter(Boolean).length;

    const clearFilters = () => {
        setYearParam(String(CURRENT_YEAR), {
            month: null, fenetre: null, statut: null, plateforme: null, campagnes: null,
        });
    };

    const fetchData = useCallback(async () => {
        setLoading(true);
        const shared = { p_window_months: windowMonths, p_exclude_ratings: excludeRatings };

        const [
            { data: perfData },
            { data: monthlyData },
            { data: campaignData },
            { data: statusData },
        ] = await Promise.all([
            cachedRpc('get_ad_performance', { ...shared, p_year: yearValue, p_month: monthValue }),
            // The monthly series is the month axis, so it ignores the month
            // filter and is skipped when no year is selected.
            yearValue === null
                ? Promise.resolve({ data: [] })
                : cachedRpc('get_ad_monthly', { ...shared, p_year: yearValue }),
            cachedRpc('get_ad_campaigns', { p_year: yearValue, p_month: monthValue, p_platform: null }),
            cachedRpc('get_ad_spend_status'),
        ]);

        setPerf((perfData as AdPerformanceRow[]) ?? []);
        setMonthly((monthlyData as AdMonthlyRow[]) ?? []);
        setCampaigns((campaignData as AdCampaignRow[]) ?? []);
        setStatus((statusData as AdSpendStatusRow[]) ?? []);
        setLoading(false);
    }, [yearValue, monthValue, windowMonths, excludeRatings]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);

    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' },
               ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );

    const windowLabel = windowParam === 'Toute'
        ? 'tout l’historique'
        : `${windowParam} mois suivant la création du compte`;

    /** No spend imported yet: credentials missing or back-fill never run. */
    const noSpendData = status.every(s => s.days === 0);

    /** Spend in a currency other than CAD makes every ratio wrong. */
    const foreignCurrency = useMemo(
        () => [...new Set(status.flatMap(s => s.currencies))].filter(c => c && c !== 'CAD'),
        [status],
    );

    /** Accounts for a channel but no spend in the period. */
    const partial = perf.filter(p => p.accounts_created > 0 && p.spend === 0);

    const openCohort = perf.some(p => isCohortOpen(p.window_ends_on));

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
                <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-1">
                    <span className="shrink-0 inline-flex h-11 w-11 md:h-12 md:w-12 items-center justify-center rounded-lg bg-white shadow-card text-ink">
                        <AdvertisingIcon className="h-6 w-6" />
                    </span>
                    <div className="min-w-0">
                        <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">
                            Comptes · Publicité
                        </h1>
                        <p className="text-xs md:text-sm text-ink-mute mt-0.5">
                            Ce que la publicité coûte, et ce que les comptes qu&rsquo;elle a ramenés ont facturé
                        </p>
                    </div>
                </div>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={yearParam}
                            onChange={v => setYearParam(v, v === 'Toutes' ? { month: null } : undefined)}
                            options={YEAR_OPTIONS} variant="accent" className="w-40" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={yearValue === null ? 'Toutes' : monthParam} onChange={setMonthParam}
                            options={monthOptions} className="w-40" disabled={yearValue === null} />
                </FilterGroup>
                <FilterGroup label="Fenêtre de revenus">
                    <Select value={windowParam} onChange={setWindowParam}
                            options={WINDOW_OPTIONS} variant="accent" className="w-44" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <Select value={ratingScope} onChange={setRatingScope} className="w-52"
                            options={[
                                { value: 'Clients', label: 'Clients seulement' },
                                { value: 'Tous',    label: 'Inclure comptes internes' },
                            ]} />
                </FilterGroup>
                <ClearFiltersButton activeCount={activeFilterCount} onClear={clearFilters} />
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Chargement des données publicitaires...</p>
                </div>
            ) : (
                <>
                    {noSpendData && <NoDataNotice />}
                    {foreignCurrency.length > 0 && <CurrencyNotice currencies={foreignCurrency} />}
                    {!noSpendData && partial.length > 0 && (
                        <PartialNotice channels={partial.map(p => p.channel)} />
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6" translate="no">
                        {perf.map(row => (
                            <ChannelCard key={row.channel} row={row} windowLabel={windowLabel} />
                        ))}
                    </div>

                    <ComparisonTable rows={perf} windowLabel={windowLabel} openCohort={openCohort} />

                    {year !== 'Toutes' && (
                        <SpendVsRevenueChart rows={monthly} year={year} windowLabel={windowLabel} />
                    )}

                    <CampaignTable
                        rows={campaigns}
                        platform={campaignPlatform}
                        onPlatformChange={setCampaignPlatform}
                        status={campaignStatus}
                        onStatusChange={setCampaignStatus}
                    />
                </>
            )}
        </div>
    );
}

// ─── Notices ──────────────────────────────────────────────────────────────────

function NoDataNotice() {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-warn-soft border border-tone-warn/30">
            <Settings2 className="w-4 h-4 text-tone-warn-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-warn-ink leading-relaxed">
                <strong className="font-semibold">Aucune dépense publicitaire n&rsquo;a encore été importée.</strong>
                {' '}Les comptes et les revenus ci-dessous sont réels ; le coût par compte et le
                rendement resteront vides tant que les accès Google Ads et Meta ne sont pas configurés
                et synchronisés (<strong>Paramètres → Synchronisation</strong>).
            </div>
        </div>
    );
}

function CurrencyNotice({ currencies }: { currencies: string[] }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-critical-soft border border-tone-critical/30">
            <AlertTriangle className="w-4 h-4 text-tone-critical-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-critical-ink leading-relaxed">
                <strong className="font-semibold">
                    Dépenses en {currencies.join(', ')}, revenus en CAD.
                </strong>{' '}
                Les ratios (coût par compte, rendement) comparent deux devises différentes et sont
                faux. Aucune conversion de devise n&rsquo;est appliquée.
            </div>
        </div>
    );
}

function PartialNotice({ channels }: { channels: AdChannel[] }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-warn-soft border border-tone-warn/30">
            <TriangleAlert className="w-4 h-4 text-tone-warn-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-warn-ink leading-relaxed">
                <strong className="font-semibold inline-flex flex-wrap items-center gap-x-1.5">
                    {channels.map((c, i) => (
                        <span key={c} className="inline-flex items-center gap-1">
                            {i > 0 && <span className="font-normal">et</span>}
                            <ChannelLogo channel={c} size="xs" />
                            {CHANNEL_LABEL[c]}
                        </span>
                    ))}
                    <span>: des comptes, mais aucune dépense sur la période.</span>
                </strong>{' '}
                Soit l&rsquo;import ne couvre pas encore ces dates, soit les accès de cette plateforme ne
                sont pas configurés. Le coût par compte et le rendement sont laissés vides plutôt
                qu&rsquo;affichés à zéro.
            </div>
        </div>
    );
}

// ─── Side-by-side comparison ──────────────────────────────────────────────────

/** Both channels side by side. */
function ComparisonTable({ rows, windowLabel, openCohort }: {
    rows: AdPerformanceRow[];
    windowLabel: string;
    openCohort: boolean;
}) {
    const best = useMemo(() => {
        const scored = rows.filter(r => r.roas !== null);
        if (scored.length < 2) return null;
        return scored.reduce((a, b) => (a.roas ?? 0) >= (b.roas ?? 0) ? a : b).channel;
    }, [rows]);

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">Comparaison des deux canaux</h3>
                <InfoHint text={`Dépenses de la période choisie, comparées aux comptes créés dans cette même période et à ce qu'ils ont facturé dans les ${windowLabel}. Le coût par compte divise la dépense par tous les comptes créés, y compris ceux qui n'ont rien acheté.`} />
                {openCohort && (
                    <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-tone-warn-soft text-tone-warn-ink">
                        Cohorte en cours
                    </span>
                )}
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-sm" translate="no">
                    <thead className="bg-sand/95">
                        <tr className="border-b border-hairline">
                            <Th align="left">Canal</Th>
                            <Th>Dépense</Th>
                            <Th>Comptes</Th>
                            <Th>Coût / compte</Th>
                            <Th>Facturés</Th>
                            <Th>Coût / client</Th>
                            <Th>Revenus</Th>
                            <Th>Revenu / compte</Th>
                            <Th>Rendement</Th>
                            <Th>Net</Th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {rows.map(r => {
                            const open = isCohortOpen(r.window_ends_on);
                            return (
                            <tr key={r.channel} className="hover:bg-sand/60 transition-colors">
                                <td className="px-4 py-3">
                                    <div className="flex items-center gap-3">
                                        <ChannelLogoTile channel={r.channel} size="sm" />
                                        <div className="min-w-0">
                                            <p className="font-semibold text-ink text-xs">{CHANNEL_LABEL[r.channel]}</p>
                                            <p className="text-2xs text-ink-mute mt-0.5 truncate max-w-[200px]"
                                               title={r.sources.join(', ')}>
                                                {r.sources.join(', ')}
                                            </p>
                                        </div>
                                    </div>
                                </td>
                                <Td value={r.spend > 0 ? formatCurrencyCAD(r.spend) : '—'} />
                                <Td value={r.accounts_created.toLocaleString('fr-CA')} />
                                <Td value={r.cost_per_account !== null ? formatCurrencyCAD(r.cost_per_account) : '—'} strong />
                                <Td value={r.accounts_invoiced.toLocaleString('fr-CA')} />
                                <Td value={r.cost_per_client !== null ? formatCurrencyCAD(r.cost_per_client) : '—'} />
                                <Td value={formatCurrencyCAD(r.revenue_attributed)} />
                                <Td value={r.revenue_per_account !== null ? formatCurrencyCAD(r.revenue_per_account) : '—'} />
                                <td className="px-4 py-3 text-right tabular-nums">
                                    {r.roas === null ? (
                                        <span className="text-ink-faint text-xs">—</span>
                                    ) : (
                                        <span className={cn(
                                            'text-xs font-bold',
                                            open ? 'text-ink-mute'
                                                : r.roas >= 1 ? 'text-tone-good' : 'text-tone-critical',
                                        )}>
                                            {r.roas.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ×
                                            {best === r.channel && rows.length > 1 && (
                                                <span className="ml-1.5 text-2xs font-bold px-1.5 py-0.5 rounded-full bg-tone-good-soft text-tone-good-ink">
                                                    Meilleur
                                                </span>
                                            )}
                                        </span>
                                    )}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                    <span className={cn('text-xs font-bold',
                                        r.spend === 0 || r.net === null ? 'text-ink-faint'
                                            : open ? 'text-ink-mute'
                                                : r.net >= 0 ? 'text-tone-good' : 'text-tone-critical')}>
                                        {r.spend === 0 || r.net === null ? '—' : formatCurrencyCAD(r.net)}
                                    </span>
                                </td>
                            </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <p className="px-5 py-3 text-2xs text-ink-mute border-t border-hairline leading-relaxed">
                « Coût / compte » est l&rsquo;équivalent du coût par lead. « Rendement » = revenus
                facturés par les comptes créés sur la période ÷ dépense publicitaire de la période.
                1,00 × signifie que la publicité s&rsquo;est payée elle-même, sans compter les coûts de
                production ni les commissions. En gris : fenêtre de revenus pas encore terminée.
            </p>
        </div>
    );
}

function Th({ children, align = 'right' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
    return (
        <th className={cn(
            'px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap',
            align === 'left' ? 'text-left' : 'text-right',
        )}>
            {children}
        </th>
    );
}

function Td({ value, strong }: { value: string; strong?: boolean }) {
    return (
        <td className={cn('px-4 py-3 text-right tabular-nums text-xs',
            strong ? 'font-bold text-ink' : 'font-semibold text-ink-secondary')}>
            {value}
        </td>
    );
}
