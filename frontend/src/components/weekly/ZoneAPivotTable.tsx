import { formatCurrencyCAD } from '../../lib/utils';
import type { ZoneA_DeptTotal } from '../../types/database';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';
import { DEPARTMENTS } from '../../lib/constants';
import { ExportButton } from '../ExportButton';
import type { CsvColumn } from '../../lib/csv';
import { RepName } from '../../components/RepAvatar';

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
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hairline flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink-secondary uppercase tracking-label">Sommaire par Représentant</h2>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-mute" translate="no">{repPivotRows.length} reps</span>
                    {/* One column per department, built from the same list the table
                        renders, so the file matches the screen even if DEPARTMENTS
                        grows again (it did - EVENEMENT, 2026-09-07). */}
                    <ExportButton
                        rows={repPivotRows}
                        columns={[
                            { header: 'Representant', value: r => String(r.repName) },
                            ...DEPARTMENTS.map(d => ({
                                header: d,
                                value: (r: { repName: string;[key: string]: string | number }) => Number(r[d] ?? 0),
                            })),
                        ] as CsvColumn<{ repName: string;[key: string]: string | number }>[]}
                        filename="sommaire_par_rep" label="CSV"
                        disabled={repPivotRows.length === 0}
                    />
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">
                                Représentant
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-ink uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-primary/5 transition-colors group"
                                onClick={() => handleSort('Total')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Total <SortIcon order={sortConfig.key === 'Total' ? sortConfig.order : null} />
                                </div>
                            </th>
                            {DEPARTMENTS.map((dept) => (
                                <th
                                    key={dept}
                                    className="px-4 py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group"
                                    onClick={() => handleSort(dept)}
                                >
                                    <div className="flex items-center justify-end gap-2">
                                        {DEPT_SHORT[dept] || dept} <SortIcon order={sortConfig.key === dept ? sortConfig.order : null} />
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={DEPARTMENTS.length + 2} className="px-5 py-10 text-center text-sm text-ink-mute italic">
                                    Aucune donnée pour cette semaine
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((row) => (
                                <tr key={String(row.repName)} className="hover:bg-sand/60 transition-colors">
                                    <td className="px-5 py-3 font-medium text-ink whitespace-nowrap"><RepName name={String(row.repName)} size="sm" /></td>
                                    <td className="px-4 py-3 text-right font-bold text-ink tabular-nums whitespace-nowrap">
                                        {formatCurrencyCAD(Number(row["Total"]))}
                                    </td>
                                    {DEPARTMENTS.map((dept) => (
                                        <td key={dept} className="px-4 py-3 text-right text-ink-mute tabular-nums whitespace-nowrap">
                                            {Number(row[dept] || 0) > 0
                                                ? formatCurrencyCAD(Number(row[dept]))
                                                : <span className="text-ink-faint">—</span>
                                            }
                                        </td>
                                    ))}
                                </tr>
                            ))
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="bg-ink text-white font-bold">
                            <td className="px-5 py-4 text-xs uppercase tracking-label whitespace-nowrap">Total</td>
                            <td className="px-4 py-4 text-right font-bold tabular-nums whitespace-nowrap">
                                {formatCurrencyCAD(grandTotal)}
                            </td>
                            {DEPARTMENTS.map((dept) => {
                                const dTotal = deptTotals.find(d => d.department === dept)?.total_amount || 0;
                                return (
                                    <td key={dept} className="px-4 py-4 text-right text-white/80 tabular-nums whitespace-nowrap text-xs">
                                        {Number(dTotal) > 0 ? formatCurrencyCAD(Number(dTotal)) : <span className="text-white/50">—</span>}
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
