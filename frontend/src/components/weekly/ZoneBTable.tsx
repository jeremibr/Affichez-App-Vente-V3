import { ExternalLink } from 'lucide-react';
import { formatCurrencyCAD, formatShortDate, cn } from '../../lib/utils';
import type { ZoneB_DetailRow } from '../../types/database';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';

export function ZoneBTable({ lineItems }: { lineItems: ZoneB_DetailRow[] }) {
    const { sortedData, sortConfig, handleSort } = useSort(lineItems);
    const totalAmount = lineItems.reduce((sum, item) => sum + Number(item.amount), 0);

    const getZohoUrl = (item: ZoneB_DetailRow) => {
        const orgId = item.office === 'MTL' ? '815683274' : '48244978';
        return `https://books.zoho.com/app/${orgId}#/quotes/${item.zoho_id}`;
    };

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Liste détaillée des devis</h2>
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 uppercase tracking-wider">
                    {lineItems.length} transactions
                </span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th
                                className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                onClick={() => handleSort('sale_date')}
                            >
                                <div className="flex items-center gap-2">
                                    Date <SortIcon order={sortConfig.key === 'sale_date' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                Statut
                            </th>
                            <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                Client
                            </th>
                            <th
                                className="px-5 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                onClick={() => handleSort('amount')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Montant <SortIcon order={sortConfig.key === 'amount' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                # Devis
                            </th>
                            <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                Représentant
                            </th>
                            <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                Département
                            </th>
                            <th className="px-5 py-3 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={8} className="px-5 py-20 text-center">
                                    <div className="flex flex-col items-center gap-2">
                                        <span className="text-2xl opacity-20">📂</span>
                                        <p className="text-sm text-slate-400 font-medium">Aucun devis trouvé pour ces critères.</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((item, idx) => (
                                <tr key={`${item.quote_number}-${idx}`} className="hover:bg-slate-50/60 transition-colors group">
                                    <td className="px-5 py-3.5 text-slate-400 whitespace-nowrap text-[11px] font-medium">{formatShortDate(item.sale_date)}</td>
                                    <td className="px-5 py-3.5">
                                        <span className={cn(
                                            "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter",
                                            item.status === 'invoiced'
                                                ? "bg-emerald-50 text-emerald-600 border border-emerald-100"
                                                : "bg-amber-50 text-amber-600 border border-amber-100"
                                        )}>
                                            {item.status === 'invoiced' ? 'Facturé' : 'Accepté'}
                                        </span>
                                    </td>
                                    <td className="px-5 py-3.5 font-bold text-slate-800 max-w-[200px] truncate" title={item.client_name}>
                                        {item.client_name}
                                    </td>
                                    <td className="px-5 py-3.5 text-right font-black text-slate-900 tabular-nums whitespace-nowrap group-hover:text-brand-main transition-colors">
                                        {formatCurrencyCAD(item.amount)}
                                    </td>
                                    <td className="px-5 py-3.5 font-mono text-[10px] text-slate-400 whitespace-nowrap">{item.quote_number}</td>
                                    <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap font-medium">{item.rep_name}</td>
                                    <td className="px-5 py-3.5">
                                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-500 whitespace-nowrap border border-slate-200/50">
                                            {item.department}
                                        </span>
                                    </td>
                                    <td className="px-5 py-3.5 text-center">
                                        <a
                                            href={getZohoUrl(item)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center justify-center p-1.5 rounded-lg text-slate-300 hover:text-brand-main hover:bg-amber-50 transition-all"
                                            title="Voir dans Zoho Books"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                    {sortedData.length > 0 && (
                        <tfoot>
                            <tr className="bg-brand-main text-white font-black">
                                <td colSpan={3} className="px-5 py-4 text-[11px] uppercase tracking-widest">Total hebdomadaire</td>
                                <td className="px-5 py-4 text-right font-black tabular-nums whitespace-nowrap">
                                    {formatCurrencyCAD(totalAmount)}
                                </td>
                                <td colSpan={4} className="px-5 py-4"></td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}
