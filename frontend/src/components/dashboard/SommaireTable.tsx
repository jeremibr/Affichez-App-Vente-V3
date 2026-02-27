import { useMemo } from 'react';
import { formatCurrencyCAD, formatPercentage, cn } from '../../lib/utils';
import type { SommaireRow } from '../../types/database';
import { MONTHS } from '../../lib/constants';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';

interface SommaireTableRow {
    label: string;
    month: number;
    prevYear: number;
    actual_amount: number;
    objectif: number;
    pct_atteint: number;
}

export function SommaireTable({
    title,
    data,
    year,
    selectedMonth
}: {
    title: string;
    data: SommaireRow[];
    year: number;
    selectedMonth?: number | 'Toutes';
}) {
    const displayMonthsRaw = selectedMonth && selectedMonth !== 'Toutes'
        ? MONTHS.filter(m => m.value === selectedMonth)
        : MONTHS;

    // Build a record of rows for easier sorting
    const rowsWithData = useMemo<SommaireTableRow[]>(() => {
        return displayMonthsRaw.map(monthObj => {
            const row = data.find(d => d.month === monthObj.value) || {
                month: monthObj.value, objectif: 0, actual_amount: 0, pct_atteint: 0
            };
            return {
                label: monthObj.label,
                month: monthObj.value,
                prevYear: 0, // Placeholder as per current impl
                actual_amount: Number(row.actual_amount || 0),
                objectif: Number(row.objectif || 0),
                pct_atteint: Number(row.pct_atteint || 0)
            };
        });
    }, [data, displayMonthsRaw]);

    const { sortedData, sortConfig, handleSort } = useSort<SommaireTableRow>(rowsWithData);

    let totalObjectif = 0;
    let totalActual = 0;

    displayMonthsRaw.forEach(m => {
        const rowData = data.find(d => d.month === m.value);
        if (rowData) {
            totalObjectif += Number(rowData.objectif || 0);
            totalActual += Number(rowData.actual_amount || 0);
        }
    });

    const totalPct = totalObjectif > 0 ? (totalActual / totalObjectif) * 100 : 0;

    const getPctStyle = (pct: number) => {
        if (pct >= 90) return 'text-emerald-600 bg-emerald-50';
        if (pct >= 50) return 'text-amber-600 bg-amber-50';
        return 'text-slate-400 bg-slate-50';
    };

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            {/* Card header */}
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">{title}</h2>
                <span className="text-xs text-slate-400 font-medium">{displayMonthsRaw.length === 1 ? displayMonthsRaw[0].label : `${year}`}</span>
            </div>

            {/* Table – no x-scroll needed, fixed layout */}
            <div className="w-full">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">
                                Période
                            </th>
                            <th className="px-5 py-3 text-right text-xs font-semibold text-slate-300 uppercase tracking-widest w-1/4 select-none">
                                {year - 1}
                            </th>
                            <th
                                className="px-5 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-50 transition-colors group"
                                onClick={() => handleSort('actual_amount')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    {year} <SortIcon order={sortConfig.key === 'actual_amount' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-5 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-50 transition-colors group"
                                onClick={() => handleSort('objectif')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Objectif <SortIcon order={sortConfig.key === 'objectif' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-5 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-50 transition-colors group"
                                onClick={() => handleSort('pct_atteint')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    % Atteint <SortIcon order={sortConfig.key === 'pct_atteint' ? sortConfig.order : null} />
                                </div>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {sortedData.map((row) => {
                            const pct = row.pct_atteint;
                            const hasData = row.actual_amount > 0;

                            return (
                                <tr key={row.month} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-5 py-3 font-medium text-slate-700">{row.label}</td>
                                    <td className="px-5 py-3 text-right text-slate-300 tabular-nums">{formatCurrencyCAD(0)}</td>
                                    <td className={cn("px-5 py-3 text-right tabular-nums font-medium", hasData ? "text-slate-800" : "text-slate-300")}>
                                        {formatCurrencyCAD(row.actual_amount)}
                                    </td>
                                    <td className="px-5 py-3 text-right text-slate-400 tabular-nums text-xs">{formatCurrencyCAD(row.objectif)}</td>
                                    <td className="px-5 py-3 text-right">
                                        {hasData ? (
                                            <span className={cn("inline-block px-2 py-0.5 rounded-md text-xs font-semibold tabular-nums", getPctStyle(pct))}>
                                                {formatPercentage(pct)}
                                            </span>
                                        ) : (
                                            <span className="text-slate-200 text-xs">—</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot>
                        <tr className="bg-brand-main text-white font-black border-t-2 border-brand-main">
                            <td className="px-5 py-4 text-xs uppercase tracking-wider">Total</td>
                            <td className="px-5 py-4 text-right text-white/50 tabular-nums text-sm">{formatCurrencyCAD(0)}</td>
                            <td className="px-5 py-4 text-right font-black tabular-nums">{formatCurrencyCAD(totalActual)}</td>
                            <td className="px-5 py-4 text-right text-white/70 tabular-nums text-xs">{formatCurrencyCAD(totalObjectif)}</td>
                            <td className="px-5 py-4 text-right">
                                <span className={cn(
                                    "inline-block px-2 py-1 rounded-md text-xs font-black tabular-nums border border-white/20",
                                    totalPct >= 90 ? "bg-emerald-500 text-white" : "bg-amber-400 text-brand-main"
                                )}>
                                    {formatPercentage(totalPct)}
                                </span>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
