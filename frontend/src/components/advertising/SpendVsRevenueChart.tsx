import { useMemo, useState } from 'react';
import type { AdMonthlyRow, AdChannel } from '../../types/database';
import { MONTHS } from '../../lib/constants';
import { InfoHint } from '../InfoHint';
import { ExportButton } from '../ExportButton';
import type { CsvColumn } from '../../lib/csv';
import { formatCurrencyCAD, cn } from '../../lib/utils';
import { CHANNELS, CHANNEL_LABEL, CHANNEL_TONE, isCohortOpen } from './channel';
import { ChannelLogo } from './ChannelLogo';

// Distinct short labels: slicing the full names gives "Jui" for both June and July.
const MONTH_SHORT = ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];

/**
 * Monthly spend against attributed revenue for one channel at a time, as paired
 * bars on a shared money axis, with the same figures in a table below.
 * Revenue bars for months whose attribution window is still open are hatched.
 */
export function SpendVsRevenueChart({ rows, year, windowLabel }: {
    rows: AdMonthlyRow[];
    year: number;
    windowLabel: string;
}) {
    const [channel, setChannel] = useState<AdChannel>('google');

    const data = useMemo(() => {
        const byMonth = new Map(
            rows.filter(r => r.channel === channel).map(r => [r.month, r]),
        );
        return MONTHS.map(m => {
            const r = byMonth.get(m.value);
            return {
                month: m.value,
                label: MONTH_SHORT[m.value - 1],
                spend: Number(r?.spend ?? 0),
                revenue: Number(r?.revenue_attributed ?? 0),
                accounts: r?.accounts_created ?? 0,
                invoiced: r?.accounts_invoiced ?? 0,
                costPerAccount: r?.cost_per_account ?? null,
                roas: r?.roas ?? null,
                open: isCohortOpen(r?.window_ends_on ?? null),
            };
        });
    }, [rows, channel]);

    const hasAnything = data.some(d => d.spend > 0 || d.revenue > 0);
    const hasComplete = data.some(d => d.revenue > 0 && !d.open);
    const hasOpen = data.some(d => d.revenue > 0 && d.open);
    const max = Math.max(1, ...data.map(d => Math.max(d.spend, d.revenue)));
    const tone = CHANNEL_TONE[channel];

    const W = 1000, H = 260, PAD_L = 64, PAD_R = 12, PAD_T = 16, PAD_B = 26;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const step = plotW / 12;
    const x = (i: number) => PAD_L + step * i;
    const barW = step * 0.34;
    const h = (v: number) => (v / max) * plotH;

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">
                    Dépense et revenus, mois par mois · {year}
                </h3>
                <InfoHint text={`Pour chaque mois : ce qui a été dépensé sur ${CHANNEL_LABEL[channel]} dans ce mois, et ce que les comptes créés dans ce même mois ont facturé dans les ${windowLabel}. Les mois hachurés n'ont pas encore une fenêtre complète : leurs revenus vont encore augmenter, donc leur rendement est sous-estimé et ne doit pas être comparé aux mois pleins.`} />

                <div className="ml-auto flex items-center gap-3">
                    <div className="flex gap-1 bg-stone p-0.5 rounded-md" role="tablist">
                        {CHANNELS.map(c => (
                            <button
                                key={c}
                                role="tab"
                                aria-selected={channel === c}
                                onClick={() => setChannel(c)}
                                className={cn(
                                    'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold whitespace-nowrap transition-all',
                                    channel === c ? 'bg-white text-ink shadow-card' : 'text-ink-mute hover:text-ink-secondary',
                                )}
                            >
                                <ChannelLogo channel={c} size="xs" />
                                {CHANNEL_LABEL[c]}
                            </button>
                        ))}
                    </div>
                    <ExportButton rows={data} columns={CSV} filename={`publicite_${channel}_${year}`}
                                  disabled={!hasAnything} />
                </div>
            </div>

            {!hasAnything ? (
                <p className="px-5 py-10 text-sm text-ink-mute text-center">
                    Aucune dépense ni revenu pour {CHANNEL_LABEL[channel]} en {year}.
                </p>
            ) : (
                <>
                    <div className="px-5 pt-4">
                        <Legend tone={tone} complete={hasComplete} open={hasOpen} />
                        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
                             className="w-full h-[260px]" role="img"
                             aria-label={`Dépense et revenus par mois pour ${CHANNEL_LABEL[channel]} en ${year}`}>
                            <defs>
                                <pattern id={`hatch-${channel}`} width="6" height="6"
                                         patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                                    <rect width="6" height="6" style={{ fill: 'var(--color-canvas)' }} />
                                    <line x1="0" y1="0" x2="0" y2="6"
                                          strokeWidth="3" style={{ stroke: tone.ink }} />
                                </pattern>
                            </defs>

                            {[0, 0.5, 1].map(f => (
                                <g key={f}>
                                    <line x1={PAD_L} x2={W - PAD_R}
                                          y1={PAD_T + plotH * (1 - f)} y2={PAD_T + plotH * (1 - f)}
                                          className="stroke-hairline" strokeWidth={1} />
                                    <text x={PAD_L - 6} y={PAD_T + plotH * (1 - f) + 3} textAnchor="end"
                                          className="fill-ink-faint" style={{ fontSize: 9 }}>
                                        {Math.round(max * f).toLocaleString('fr-CA')} $
                                    </text>
                                </g>
                            ))}

                            {data.map((d, i) => {
                                const spendH = h(d.spend);
                                const revH = h(d.revenue);
                                const left = x(i) + step / 2 - barW - 2;
                                return (
                                    <g key={d.month}>
                                        <rect x={left} y={PAD_T + plotH - spendH}
                                              width={barW} height={Math.max(0, spendH)}
                                              rx={2} style={{ fill: 'var(--color-hairline-strong)' }} />
                                        <rect x={left + barW + 4} y={PAD_T + plotH - revH}
                                              width={barW} height={Math.max(0, revH)}
                                              rx={2} strokeWidth={1}
                                              style={{
                                                  fill: d.open ? `url(#hatch-${channel})` : tone.ink,
                                                  stroke: d.open ? tone.ink : 'none',
                                              }} />
                                    </g>
                                );
                            })}

                            {data.map((d, i) => (
                                <text key={d.month} x={x(i) + step / 2} y={H - 8} textAnchor="middle"
                                      className={d.open ? 'fill-ink-faint' : 'fill-ink-mute'}
                                      style={{ fontSize: 10 }}>
                                    {d.label}
                                </text>
                            ))}
                        </svg>
                    </div>

                    <div className="overflow-x-auto px-5 pb-5 pt-2">
                        <table className="w-full text-sm" translate="no">
                            <thead>
                                <tr className="border-b border-hairline">
                                    <th className="py-2 pr-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Mois</th>
                                    <th className="py-2 px-2 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Dépense</th>
                                    <th className="py-2 px-2 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Comptes</th>
                                    <th className="py-2 px-2 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Coût / compte</th>
                                    <th className="py-2 px-2 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Facturés</th>
                                    <th className="py-2 px-2 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Revenus</th>
                                    <th className="py-2 pl-2 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Rendement</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {data.map(d => (
                                    <tr key={d.month}
                                        className={cn('hover:bg-sand/60',
                                                      d.spend === 0 && d.accounts === 0 && 'opacity-40')}>
                                        <td className="py-1.5 pr-3 font-semibold text-ink-secondary text-xs">
                                            {d.label}
                                            {d.open && (d.spend > 0 || d.accounts > 0) && (
                                                <span className="ml-1.5 text-2xs font-semibold text-tone-warn-ink"
                                                      title="La fenêtre d'attribution de ce mois n'est pas terminée : les revenus vont encore augmenter.">
                                                    en cours
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-1.5 px-2 text-right tabular-nums text-ink-secondary text-xs">
                                            {d.spend > 0 ? formatCurrencyCAD(d.spend) : '—'}
                                        </td>
                                        <td className="py-1.5 px-2 text-right tabular-nums text-ink-secondary">{d.accounts}</td>
                                        <td className="py-1.5 px-2 text-right tabular-nums text-ink-secondary text-xs">
                                            {d.costPerAccount !== null ? formatCurrencyCAD(d.costPerAccount) : '—'}
                                        </td>
                                        <td className="py-1.5 px-2 text-right tabular-nums text-ink-mute">{d.invoiced}</td>
                                        <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-ink text-xs">
                                            {formatCurrencyCAD(d.revenue)}
                                        </td>
                                        <td className="py-1.5 pl-2 text-right tabular-nums">
                                            {d.roas === null ? (
                                                <span className="text-ink-faint text-xs">—</span>
                                            ) : (
                                                <span className={cn('text-xs font-bold',
                                                    d.open ? 'text-ink-mute'
                                                        : d.roas >= 1 ? 'text-tone-good' : 'text-tone-critical')}>
                                                    {d.roas.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ×
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}

function Legend({ tone, complete, open }: { tone: { ink: string }; complete: boolean; open: boolean }) {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs font-semibold text-ink-mute mb-1" translate="no">
            <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-3 rounded-xs" style={{ backgroundColor: 'var(--color-hairline-strong)' }} />
                Dépense
            </span>
            {complete && (
                <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-3 rounded-xs" style={{ backgroundColor: tone.ink }} />
                    Revenus facturés
                </span>
            )}
            {open && (
                <span className="flex items-center gap-1.5">
                    {/* The same hatch the bars use, so the swatch is recognisable. */}
                    <svg width="12" height="10" aria-hidden>
                        <defs>
                            <pattern id="legend-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                                <rect width="4" height="4" style={{ fill: 'var(--color-canvas)' }} />
                                <line x1="0" y1="0" x2="0" y2="4" strokeWidth="2" style={{ stroke: tone.ink }} />
                            </pattern>
                        </defs>
                        <rect width="12" height="10" rx="2" fill="url(#legend-hatch)" strokeWidth="1" style={{ stroke: tone.ink }} />
                    </svg>
                    Revenus facturés — encore en cours
                </span>
            )}
        </div>
    );
}

type Row = {
    label: string; spend: number; accounts: number; invoiced: number;
    revenue: number; costPerAccount: number | null; roas: number | null; open: boolean;
};

const CSV: CsvColumn<Row>[] = [
    { header: 'Mois',                value: d => d.label },
    { header: 'Dépense',             value: d => d.spend },
    { header: 'Comptes créés',       value: d => d.accounts },
    { header: 'Coût par compte',     value: d => d.costPerAccount },
    { header: 'Comptes facturés',    value: d => d.invoiced },
    { header: 'Revenus attribués',   value: d => d.revenue },
    { header: 'Rendement',           value: d => d.roas },
    { header: 'Fenêtre en cours',    value: d => d.open ? 'oui' : 'non' },
];
