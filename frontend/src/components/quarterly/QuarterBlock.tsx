import { formatCurrencyCAD, cn } from '../../lib/utils';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { YoYRow } from '../../types/database';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';

export function QuarterBlock({
    quarter,
    data,
    currentYear
}: {
    quarter: number;
    data: YoYRow[];
    currentYear: number;
}) {
    const previousYear = currentYear - 1;
    const { sortedData, sortConfig, handleSort } = useSort(data);

    const totalCurrent = data.reduce((sum, row) => sum + Number(row.current_avg || 0), 0);
    const totalPrevious = data.reduce((sum, row) => sum + Number(row.previous_avg || 0), 0);
    const totalResultat = totalCurrent - totalPrevious;

    const getStyle = (val: number) => {
        if (val > 0) return 'text-emerald-600 bg-emerald-50';
        if (val < 0) return 'text-red-500 bg-red-50';
        return 'text-slate-400 bg-slate-50';
    };

    const getIcon = (val: number) => {
        if (val > 0) return <TrendingUp className="w-3.5 h-3.5 inline mr-1" />;
        if (val < 0) return <TrendingDown className="w-3.5 h-3.5 inline mr-1" />;
        return <Minus className="w-3.5 h-3.5 inline mr-1" />;
    };

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Trimestre {quarter}</h2>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-brand-main">
                    Q{quarter} · {currentYear}
                </span>
            </div>

            <div className="flex-1 overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">
                                Représentant
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                onClick={() => handleSort('current_avg')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    {currentYear} <SortIcon order={sortConfig.key === 'current_avg' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-slate-300 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                onClick={() => handleSort('previous_avg')}
                            >
                                <div className="flex items-center justify-end gap-2 text-slate-300">
                                    {previousYear} <SortIcon order={sortConfig.key === 'previous_avg' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                onClick={() => handleSort('resultat')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Δ Résultat <SortIcon order={sortConfig.key === 'resultat' ? sortConfig.order : null} />
                                </div>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-5 py-8 text-center text-sm text-slate-400 italic">
                                    Aucune donnée pour ce trimestre
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((row, idx) => {
                                const res = Number(row.resultat);
                                return (
                                    <tr key={idx} className="hover:bg-slate-50/60 transition-colors group">
                                        <td className="px-5 py-3 font-medium text-slate-700 whitespace-nowrap">{row.rep_name}</td>
                                        <td className="px-4 py-3 text-right font-semibold text-slate-800 tabular-nums group-hover:text-brand-main transition-colors whitespace-nowrap">
                                            {formatCurrencyCAD(row.current_avg)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-slate-300 tabular-nums whitespace-nowrap">
                                            {formatCurrencyCAD(row.previous_avg)}
                                        </td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap">
                                            <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold tabular-nums", getStyle(res))}>
                                                {getIcon(res)}{formatCurrencyCAD(Math.abs(res))}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="bg-brand-main text-white font-black">
                            <td className="px-5 py-3.5 text-xs uppercase tracking-wider">Total équipe</td>
                            <td className="px-4 py-3.5 text-right font-black tabular-nums whitespace-nowrap">{formatCurrencyCAD(totalCurrent)}</td>
                            <td className="px-4 py-3.5 text-right text-white/50 tabular-nums whitespace-nowrap">{formatCurrencyCAD(totalPrevious)}</td>
                            <td className="px-4 py-3.5 text-right whitespace-nowrap">
                                <span className={cn(
                                    "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-black tabular-nums border border-white/20",
                                    totalResultat >= 0 ? "bg-emerald-500 text-white" : "bg-red-500 text-white"
                                )}>
                                    {getIcon(totalResultat)}{formatCurrencyCAD(Math.abs(totalResultat))}
                                </span>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
