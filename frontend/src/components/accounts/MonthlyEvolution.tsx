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
                delta: prevRpa > 0 ? ((curRpa - prevRpa) / prevRpa) * 100 : null,
            };
        });
    }, [current, previous]);

    const maxAccounts = Math.max(1, ...data.map(d => Math.max(d.accounts, d.prevAccounts)));
    const maxRpa = Math.max(1, ...data.map(d => Math.max(d.rpa, d.prevRpa)));

    // Plot geometry. viewBox units, scaled by CSS — so the chart stays sharp at
    // any width without a resize observer.
    const W = 720, H = 200, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 22;
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
                    <Legend />
                    <ExportButton rows={data} columns={MONTHLY_CSV} filename="comptes_par_mois" disabled={data.every(d => d.accounts === 0)} />
                </div>
            </div>

            <div className="px-5 pt-4">
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[200px]" role="img"
                     aria-label="Comptes créés et revenu par compte, mois par mois">
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

                    {/* Previous year's quality line, behind the current one */}
                    {hasPrevious && (
                        <path d={linePath('prevRpa')} fill="none"
                              className="stroke-slate-300" strokeWidth={1.5}
                              strokeDasharray="4 3" strokeLinejoin="round" />
                    )}

                    {/* Current year */}
                    <path d={linePath('rpa')} fill="none"
                          className="stroke-brand-main" strokeWidth={2} strokeLinejoin="round" />
                    {data.map((d, i) => (
                        <circle key={d.month} cx={x(i)} cy={y(d.rpa)} r={2.5}
                                className="fill-white stroke-brand-main" strokeWidth={1.5} />
                    ))}

                    {data.map((d, i) => (
                        <text key={d.month} x={x(i)} y={H - 6} textAnchor="middle"
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
                                    <td className="py-1.5 pl-2 text-right tabular-nums text-xs font-bold">
                                        {d.delta === null ? (
                                            <span className="text-slate-300">—</span>
                                        ) : (
                                            <span className={d.delta >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                                                {d.delta >= 0 ? '+' : ''}{d.delta.toFixed(0)} %
                                            </span>
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

function Legend() {
    return (
        <div className="flex items-center gap-3 text-[10px] font-semibold text-slate-400">
            <span className="flex items-center gap-1.5">
                <span className="w-3 h-2 rounded-sm bg-slate-100 border border-slate-200" />
                Comptes
            </span>
            <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded bg-brand-main" />
                $ / compte
            </span>
            <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded bg-slate-300" />
                An dernier
            </span>
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
