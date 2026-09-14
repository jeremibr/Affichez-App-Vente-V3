import { useMemo } from 'react';
import type { ZohoAccountMonthlyRow } from '../../types/database';
import { MONTHS } from '../../lib/constants';
import { InfoHint } from '../InfoHint';
import { ExportButton } from '../ExportButton';
import type { CsvColumn } from '../../lib/csv';
import { formatCurrencyCAD, cn } from '../../lib/utils';

/**
 * Month-by-month account cohorts, this year against last.
 *
 * The dashboard's headline numbers answer "how did this period do". This answers
 * the question Dominic actually asked in the 2026-09-04 meeting, which is a
 * comparison: "juillet, c'est des leads de merde... je veux qu'on coupe là-dedans
 * puis qu'on mette plus ailleurs." You cannot make that call from one number.
 *
 * Drawn as inline SVG rather than pulling in a charting library: two series of
 * twelve points needs about forty lines of path arithmetic, against ~150KB of
 * dependency, and the app currently ships no chart library at all.
 *
 * Revenue per account is the plotted line, not total revenue, and that is
 * deliberate — a month with twice the accounts will always show more total
 * revenue, which tells you about volume rather than quality. The bars carry the
 * volume so both are readable at once.
 */
export function MonthlyEvolution({ current, previous, year, previousYear, windowLabel }: {
    current: ZohoAccountMonthlyRow[];
    previous: ZohoAccountMonthlyRow[];
    year: number | 'Toutes';
    previousYear: number | null;
    windowLabel: string;
}) {
    const data = useMemo(() => {
        const prevBy = new Map(previous.map(r => [r.month, r]));
        return MONTHS.map(m => {
            const cur = current.find(r => r.month === m.value);
            const prev = prevBy.get(m.value);
            const curRpa = Number(cur?.revenue_per_account ?? 0);
            const prevRpa = Number(prev?.revenue_per_account ?? 0);
            return {
                month: m.value,
                label: m.label.slice(0, 3),
                accounts: cur?.nb_accounts ?? 0,
                invoiced: cur?.nb_invoiced ?? 0,
                amount: Number(cur?.total_amount ?? 0),
                rpa: curRpa,
                prevAccounts: prev?.nb_accounts ?? 0,
                prevRpa,
                // Null rather than 0 when there is no prior month to compare
                // against: "no data" and "flat" are different answers.
                //
                // Both the dollar gap and the percentage are kept. A percentage
                // on its own is unreadable at these volumes — "+240 %" is a good
                // month or a rounding artefact on two accounts, and the column
                // gave you no way to tell which. Same shape as the VS column on
                // the Devis and Factures dashboards.
                deltaAmount: prevRpa > 0 ? curRpa - prevRpa : null,
                delta: prevRpa > 0 ? ((curRpa - prevRpa) / prevRpa) * 100 : null,
            };
        });
    }, [current, previous]);

    const maxAccounts = Math.max(1, ...data.map(d => Math.max(d.accounts, d.prevAccounts)));
    const maxRpa = Math.max(1, ...data.map(d => Math.max(d.rpa, d.prevRpa)));

    // Plot geometry. viewBox units scaled by CSS, so the chart is sharp at any
    // width without a resize observer — and `preserveAspectRatio="none"` below
    // lets it stretch to the full card instead of sitting in a 720px box with
    // empty space either side, which is how it first shipped.
    //
    // PAD_L leaves room for the value labels on the left; they are what makes
    // the line readable as money rather than as a shape.
    const W = 1000, H = 240, PAD_L = 54, PAD_R = 12, PAD_T = 16, PAD_B = 24;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const step = plotW / 12;
    const x = (i: number) => PAD_L + step * i + step / 2;
    const y = (v: number) => PAD_T + plotH - (v / maxRpa) * plotH;

    const linePath = (key: 'rpa' | 'prevRpa') =>
        data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(' ');

    const hasPrevious = previousYear !== null && previous.some(r => r.nb_accounts > 0);

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-slate-800">
                    Évolution mensuelle{year !== 'Toutes' && ` — ${year}`}
                </h3>
                <InfoHint text={`Les barres montrent le nombre de comptes créés chaque mois. La ligne montre le revenu par compte sur ${windowLabel} — c'est elle qui dit si un mois a ramené de bons clients ou seulement beaucoup de clients. La ligne pâle est l'année précédente.`} />
                <div className="ml-auto flex items-center gap-3">
                    <Legend year={year} previousYear={hasPrevious ? previousYear : null} />
                    <ExportButton rows={data} columns={MONTHLY_CSV} filename="comptes_par_mois" disabled={data.every(d => d.accounts === 0)} />
                </div>
            </div>

            <div className="px-5 pt-4">
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
                     className="w-full h-[240px]" role="img"
                     aria-label="Comptes créés et revenu par compte, mois par mois">
                    {/* Three gridlines and their values. Without them the line has
                        no scale at all — you can see that August beat July, but not
                        by $40 or $400. */}
                    {[0, 0.5, 1].map(f => (
                        <g key={f}>
                            <line x1={PAD_L} x2={W - PAD_R}
                                  y1={PAD_T + plotH * (1 - f)} y2={PAD_T + plotH * (1 - f)}
                                  className="stroke-slate-100" strokeWidth={1} />
                            <text x={PAD_L - 6} y={PAD_T + plotH * (1 - f) + 3} textAnchor="end"
                                  className="fill-slate-300" style={{ fontSize: 9 }}>
                                {Math.round(maxRpa * f).toLocaleString('fr-CA')}
                            </text>
                        </g>
                    ))}
                    {/* Volume bars, current year */}
                    {data.map((d, i) => {
                        const h = (d.accounts / maxAccounts) * plotH;
                        return (
                            <rect
                                key={d.month}
                                x={x(i) - step * 0.28} y={PAD_T + plotH - h}
                                width={step * 0.56} height={Math.max(0, h)}
                                rx={2} className="fill-slate-100"
                            />
                        );
                    })}

                    {/* Last year: dashed, grey, hollow square markers, thin. Two
                        orange-ish lines of the same weight were the complaint —
                        colour alone was not enough to tell them apart, so they now
                        differ in colour AND dash AND marker shape. */}
                    {hasPrevious && (
                        <>
                            <path d={linePath('prevRpa')} fill="none"
                                  className="stroke-slate-400" strokeWidth={1.5}
                                  strokeDasharray="5 4" strokeLinejoin="round" />
                            {data.map((d, i) => (
                                <rect key={d.month} x={x(i) - 2.5} y={y(d.prevRpa) - 2.5}
                                      width={5} height={5}
                                      className="fill-white stroke-slate-400" strokeWidth={1.25} />
                            ))}
                        </>
                    )}

                    {/* This year: solid, brand orange, filled round markers, thicker. */}
                    <path d={linePath('rpa')} fill="none"
                          className="stroke-brand-main" strokeWidth={2.5} strokeLinejoin="round" />
                    {data.map((d, i) => (
                        <circle key={d.month} cx={x(i)} cy={y(d.rpa)} r={3.5}
                                className="fill-brand-main stroke-white" strokeWidth={1.5} />
                    ))}

                    {data.map((d, i) => (
                        <text key={d.month} x={x(i)} y={H - 8} textAnchor="middle"
                              className="fill-slate-400" style={{ fontSize: 10 }}>
                            {d.label}
                        </text>
                    ))}
                </svg>
            </div>

            <div className="overflow-x-auto px-5 pb-5 pt-2">
                <table className="w-full text-sm" translate="no">
                    <thead>
                        <tr className="border-b border-slate-100">
                            <th className="py-2 pr-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Mois</th>
                            <th className="py-2 px-2 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Comptes</th>
                            <th className="py-2 px-2 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Facturés</th>
                            <th className="py-2 px-2 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Revenus</th>
                            <th className="py-2 px-2 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">/ compte</th>
                            {hasPrevious && (
                                <th className="py-2 pl-2 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                    vs {previousYear}
                                </th>
                            )}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {data.map(d => (
                            <tr key={d.month} className={cn('hover:bg-slate-50/60', d.accounts === 0 && 'opacity-40')}>
                                <td className="py-1.5 pr-3 font-semibold text-slate-600 text-xs">{d.label}</td>
                                <td className="py-1.5 px-2 text-right tabular-nums text-slate-700">{d.accounts}</td>
                                <td className="py-1.5 px-2 text-right tabular-nums text-slate-500">{d.invoiced}</td>
                                <td className="py-1.5 px-2 text-right tabular-nums text-slate-700 text-xs">{formatCurrencyCAD(d.amount)}</td>
                                <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-brand-dark text-xs">{formatCurrencyCAD(d.rpa)}</td>
                                {hasPrevious && (
                                    <td className="py-1.5 pl-2 text-right tabular-nums">
                                        {d.delta === null || d.deltaAmount === null ? (
                                            <span className="text-slate-300 text-xs">—</span>
                                        ) : (
                                            <div className="flex flex-col items-end gap-0.5 leading-tight">
                                                <span className={cn('text-xs font-semibold whitespace-nowrap',
                                                    d.deltaAmount >= 0 ? 'text-emerald-600' : 'text-rose-500')}>
                                                    {d.deltaAmount >= 0 ? '+' : ''}{formatCurrencyCAD(d.deltaAmount)}
                                                </span>
                                                <span className={cn('text-[10px] font-bold',
                                                    d.delta >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                                                    {d.delta >= 0 ? '+' : ''}{d.delta.toFixed(0)} %
                                                </span>
                                            </div>
                                        )}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/**
 * Named years rather than "An dernier", and swatches that actually show the
 * difference — a solid bar with a dot against a dashed one with a square. The
 * legend has to be readable on its own, because it is what the reader consults
 * when the two lines cross.
 */
function Legend({ year, previousYear }: { year: number | 'Toutes'; previousYear: number | null }) {
    const thisLabel = year === 'Toutes' ? 'Revenu / compte' : `${year}`;
    return (
        <div className="flex items-center gap-3 text-[10px] font-semibold text-slate-400" translate="no">
            <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2 rounded-sm bg-slate-100 ring-1 ring-inset ring-slate-200" />
                Comptes créés
            </span>
            <span className="flex items-center gap-1.5 text-brand-main">
                <svg width="22" height="8" aria-hidden>
                    <line x1="0" y1="4" x2="22" y2="4" className="stroke-brand-main" strokeWidth={2.5} />
                    <circle cx="11" cy="4" r="3" className="fill-brand-main stroke-white" strokeWidth={1.5} />
                </svg>
                {thisLabel} — $ / compte
            </span>
            {previousYear !== null && (
                <span className="flex items-center gap-1.5">
                    <svg width="22" height="8" aria-hidden>
                        <line x1="0" y1="4" x2="22" y2="4" className="stroke-slate-400"
                              strokeWidth={1.5} strokeDasharray="5 4" />
                        <rect x="8.5" y="1.5" width="5" height="5"
                              className="fill-white stroke-slate-400" strokeWidth={1.25} />
                    </svg>
                    {previousYear}
                </span>
            )}
        </div>
    );
}

type MonthRow = {
    label: string; accounts: number; invoiced: number; amount: number;
    rpa: number; prevAccounts: number; prevRpa: number; delta: number | null;
};

const MONTHLY_CSV: CsvColumn<MonthRow>[] = [
    { header: 'Mois',                 value: d => d.label },
    { header: 'Comptes',              value: d => d.accounts },
    { header: 'Comptes factures',     value: d => d.invoiced },
    { header: 'Revenus',              value: d => d.amount },
    { header: 'Revenu par compte',    value: d => d.rpa },
    { header: 'Comptes an dernier',   value: d => d.prevAccounts },
    { header: 'Revenu/compte an dernier', value: d => d.prevRpa },
    { header: 'Variation (%)',        value: d => d.delta },
];
