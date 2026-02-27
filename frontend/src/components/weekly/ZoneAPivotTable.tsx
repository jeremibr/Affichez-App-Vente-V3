import { formatCurrencyCAD } from '../../lib/utils';
import type { ZoneA_DeptTotal } from '../../types/database';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';

const DEPARTMENTS = [
    'MULTI-ANNONCEURS',
    'PROMOTIONNEL',
    'DIST. PUBLICITAIRE SOLO',
    'NUMERIQUE',
    'APPLICATION',
    'SERVICES IA'
] as const;

// Shorter display names for table headers
const DEPT_SHORT: Record<string, string> = {
    'MULTI-ANNONCEURS': 'Multi-ann.',
    'PROMOTIONNEL': 'Promo',
    'DIST. PUBLICITAIRE SOLO': 'Dist. Solo',
    'NUMERIQUE': 'Numérique',
    'APPLICATION': 'App',
    'SERVICES IA': 'IA',
};

export function ZoneAPivotTable({
    repPivotRows,
    grandTotal,
    deptTotals,
}: {
    repPivotRows: { repName: string;[key: string]: string | number }[];
    grandTotal: number;
    deptTotals: ZoneA_DeptTotal[];
}) {
    const { sortedData, sortConfig, handleSort } = useSort(repPivotRows);

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Sommaire par Représentant</h2>
                <span className="text-xs text-slate-400">{repPivotRows.length} reps</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest sticky left-0 bg-slate-50/50">
                                Représentant
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-brand-main uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-brand-main/5 transition-colors group"
                                onClick={() => handleSort('Total')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Total <SortIcon order={sortConfig.key === 'Total' ? sortConfig.order : null} />
                                </div>
                            </th>
                            {DEPARTMENTS.map((dept) => (
                                <th
                                    key={dept}
                                    className="px-4 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                    onClick={() => handleSort(dept)}
                                >
                                    <div className="flex items-center justify-end gap-2">
                                        {DEPT_SHORT[dept] || dept} <SortIcon order={sortConfig.key === dept ? sortConfig.order : null} />
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={DEPARTMENTS.length + 2} className="px-5 py-10 text-center text-sm text-slate-400 italic">
                                    Aucune donnée pour cette semaine
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((row) => (
                                <tr key={String(row.repName)} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-5 py-3 font-medium text-slate-800 whitespace-nowrap">{row.repName}</td>
                                    <td className="px-4 py-3 text-right font-bold text-brand-main tabular-nums whitespace-nowrap">
                                        {formatCurrencyCAD(Number(row["Total"]))}
                                    </td>
                                    {DEPARTMENTS.map((dept) => (
                                        <td key={dept} className="px-4 py-3 text-right text-slate-500 tabular-nums whitespace-nowrap">
                                            {Number(row[dept] || 0) > 0
                                                ? formatCurrencyCAD(Number(row[dept]))
                                                : <span className="text-slate-200">—</span>
                                            }
                                        </td>
                                    ))}
                                </tr>
                            ))
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="bg-brand-main text-white font-black">
                            <td className="px-5 py-4 text-xs uppercase tracking-wider">Total</td>
                            <td className="px-4 py-4 text-right font-black tabular-nums whitespace-nowrap">
                                {formatCurrencyCAD(grandTotal)}
                            </td>
                            {DEPARTMENTS.map((dept) => {
                                const dTotal = deptTotals.find(d => d.department === dept)?.total_amount || 0;
                                return (
                                    <td key={dept} className="px-4 py-4 text-right text-white/80 tabular-nums whitespace-nowrap text-xs">
                                        {Number(dTotal) > 0 ? formatCurrencyCAD(Number(dTotal)) : <span className="text-white/20">—</span>}
                                    </td>
                                );
                            })}
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
