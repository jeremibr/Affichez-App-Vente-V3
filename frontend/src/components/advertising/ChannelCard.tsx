import { DollarSign, Building2, Receipt, MousePointerClick } from 'lucide-react';
import type { AdPerformanceRow } from '../../types/database';
import { formatCurrencyCAD, cn } from '../../lib/utils';
import { InfoHint } from '../InfoHint';
import { channelLabel, isCohortOpen, formatReturn, ORGANIC_CAVEAT } from './channel';
import { ChannelLogoTile } from './ChannelLogo';

/**
 * One ad channel: return on spend as the headline, then spend, revenue and the
 * acquisition costs, with platform reach figures underneath.
 *
 * In the organic view the same card shows the accounts that came through the
 * platform without an ad: revenue as the headline, accounts and revenue per
 * account below, and no spend anywhere, because there is none to divide by.
 *
 * While the attribution window is open the return is shown muted and labelled,
 * rather than hidden, so it is not recomputed by hand from the figures below.
 */
export function ChannelCard({ row, windowLabel, organic = false }: {
    row: AdPerformanceRow;
    windowLabel: string;
    organic?: boolean;
}) {
    const open = isCohortOpen(row.window_ends_on);
    const hasSpend = row.spend > 0;
    const ctr = row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null;
    const label = channelLabel(row.channel, organic);
    const sources = row.sources.join(', ');
    const invoicedShare = row.accounts_created > 0
        ? Math.round((row.accounts_invoiced / row.accounts_created) * 100)
        : null;
    const plural = (n: number) => (n > 1 ? 's' : '');

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-hairline flex items-center gap-3">
                <ChannelLogoTile channel={row.channel} />
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink">{label}</h3>
                    <p className="text-2xs text-ink-mute truncate">Origine : {sources}</p>
                </div>
                <InfoHint text={`Comptes dont « Origine du client » est : ${sources}.`} />
            </div>

            {organic ? (
                <>
                    <div className="px-5 py-5 border-b border-hairline bg-sand/60">
                        <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                            Revenus attribués
                        </p>
                        {row.accounts_created === 0 ? (
                            <>
                                <p className="mt-1 text-2xl font-bold text-ink-mute tabular-nums">—</p>
                                <p className="text-2xs text-ink-mute mt-1 font-medium italic">
                                    Aucun compte « {sources} » créé sur la période
                                </p>
                            </>
                        ) : (
                            <>
                                <p className={cn('mt-1 text-2xl md:text-3xl font-bold tabular-nums',
                                                 open ? 'text-ink-mute' : 'text-ink')}>
                                    {formatCurrencyCAD(row.revenue_attributed)}
                                </p>
                                <p className={cn('text-2xs mt-1 font-medium italic',
                                                 open ? 'text-tone-warn-ink' : 'text-ink-mute')}>
                                    {open
                                        ? `Cohorte en cours — fenêtre complète le ${formatDay(row.window_ends_on)}`
                                        : `Facturé dans les ${windowLabel}`}
                                </p>
                            </>
                        )}
                    </div>

                    <div className="grid grid-cols-2 divide-x divide-hairline border-b border-hairline">
                        <Stat
                            icon={Building2}
                            label="Comptes créés"
                            value={row.accounts_created.toLocaleString('fr-CA')}
                            sub={`${row.accounts_invoiced} facturé${plural(row.accounts_invoiced)}${invoicedShare !== null ? ` (${invoicedShare} %)` : ''}`}
                        />
                        <Stat
                            icon={Receipt}
                            label="Revenu par compte"
                            value={row.revenue_per_account !== null ? formatCurrencyCAD(row.revenue_per_account) : '—'}
                            sub="tous les comptes créés, même sans achat"
                            hint="Revenus attribués ÷ comptes créés sur la période, la même mesure que sur Comptes."
                        />
                    </div>

                    <p className="px-5 py-3 mt-auto text-2xs text-ink-mute leading-relaxed bg-sand/60">
                        {ORGANIC_CAVEAT[row.channel]}
                    </p>
                </>
            ) : (
                <>
                    <div className="px-5 py-5 border-b border-hairline bg-sand/60">
                        <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                            Retour sur la dépense
                        </p>
                        {row.roas === null ? (
                            <>
                                <p className="mt-1 text-2xl font-bold text-ink-mute tabular-nums">—</p>
                                <p className="text-2xs text-ink-mute mt-1 font-medium italic">
                                    {hasSpend
                                        ? `Aucun compte « ${sources} » créé sur la période`
                                        : 'Aucune dépense importée sur la période'}
                                </p>
                            </>
                        ) : (
                            <>
                                <p className={cn('mt-1 text-2xl md:text-3xl font-bold tabular-nums',
                                                 open ? 'text-ink-mute' : 'text-ink')}>
                                    {formatReturn(row.roas)}
                                </p>
                                <p className={cn('text-2xs mt-1 font-medium italic',
                                                 open ? 'text-tone-warn-ink' : 'text-ink-mute')}>
                                    {open
                                        ? `Cohorte en cours — fenêtre complète le ${formatDay(row.window_ends_on)}`
                                        : `Facturé dans les ${windowLabel}`}
                                </p>
                            </>
                        )}
                    </div>

                    <div className="grid grid-cols-2 divide-x divide-hairline border-b border-hairline">
                        <Stat
                            icon={DollarSign}
                            label="Dépense"
                            value={hasSpend ? formatCurrencyCAD(row.spend) : '—'}
                            sub={hasSpend
                                ? `${row.days_with_spend} jour${plural(row.days_with_spend)} de données`
                                : 'Non importée'}
                        />
                        <Stat
                            icon={Receipt}
                            label="Revenus attribués"
                            value={formatCurrencyCAD(row.revenue_attributed)}
                            sub={`${row.accounts_invoiced} compte${plural(row.accounts_invoiced)} facturé${plural(row.accounts_invoiced)}`}
                        />
                    </div>

                    <div className="grid grid-cols-2 divide-x divide-hairline border-b border-hairline">
                        <Stat
                            icon={Building2}
                            label="Coût par compte"
                            value={row.cost_per_account !== null ? formatCurrencyCAD(row.cost_per_account) : '—'}
                            sub={`${row.accounts_created} compte${plural(row.accounts_created)} créé${plural(row.accounts_created)}`}
                            hint="Équivalent du coût par lead : dépense ÷ comptes créés sur la période, y compris ceux qui n'ont rien acheté."
                        />
                        <Stat
                            icon={Building2}
                            label="Coût par client"
                            value={row.cost_per_client !== null ? formatCurrencyCAD(row.cost_per_client) : '—'}
                            sub={invoicedShare !== null ? `${invoicedShare} % ont facturé` : '—'}
                            hint="Dépense ÷ comptes qui ont été facturés."
                        />
                    </div>

                    <div className="px-5 py-3 mt-auto flex flex-wrap items-center gap-x-5 gap-y-1 bg-sand/60">
                        <MousePointerClick className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                        <Mini label="Impressions" value={row.impressions.toLocaleString('fr-CA')} />
                        <Mini label="Clics" value={row.clicks.toLocaleString('fr-CA')} />
                        {ctr !== null && (
                            <Mini label="CTR" value={`${ctr.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`} />
                        )}
                        <Mini
                            label="Conversions plateforme"
                            value={row.platform_conversions.toLocaleString('fr-CA', { maximumFractionDigits: 0 })}
                        />
                    </div>
                </>
            )}
        </div>
    );
}

function Stat({ icon: Icon, label, value, sub, hint }: {
    icon: React.ElementType;
    label: string;
    value: string;
    sub: string;
    hint?: string;
}) {
    return (
        <div className="px-5 py-4">
            <div className="flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">{label}</p>
                {hint && <InfoHint text={hint} />}
            </div>
            <p className="mt-1.5 text-base md:text-lg font-bold text-ink tabular-nums">{value}</p>
            <p className="text-2xs text-ink-mute mt-0.5 font-medium italic">{sub}</p>
        </div>
    );
}

function Mini({ label, value }: { label: string; value: string }) {
    return (
        <span className="text-2xs text-ink-mute">
            {label} <strong className="font-bold text-ink-secondary tabular-nums ml-0.5">{value}</strong>
        </span>
    );
}

function formatDay(iso: string | null): string {
    if (!iso) return '';
    return new Date(`${iso}T00:00:00`).toLocaleDateString('fr-CA', {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}
