import { ExternalLink } from 'lucide-react';
import { formatCurrencyCAD, formatShortDate, cn } from '../../lib/utils';
import type { ZoneB_DetailRow, InvDetailRow } from '../../types/database';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';

type AnyDetailRow = ZoneB_DetailRow | InvDetailRow;

interface ZoneBTableProps {
    lineItems: AnyDetailRow[];
    module?: 'devis' | 'factures';
}

export function ZoneBTable({ lineItems, module = 'devis' }: ZoneBTableProps) {
    const dateKey = (module === 'factures' ? 'invoice_date' : 'sale_date') as keyof AnyDetailRow;
    const { sortedData, sortConfig, handleSort } = useSort(lineItems as AnyDetailRow[], dateKey, 'desc');
    const totalAmount = lineItems.reduce((sum, item) => sum + Number(item.amount), 0);

    const getZohoUrl = (item: AnyDetailRow) => {
        const orgId = item.office === 'MTL' ? '815683274' : '48244978';
        const path = module === 'factures' ? 'invoices' : 'quotes';
        return `https://books.zoho.com/app/${orgId}#/${path}/${item.zoho_id}`;
    };

    const getDate = (item: AnyDetailRow) =>
        module === 'factures' ? (item as InvDetailRow).invoice_date : (item as ZoneB_DetailRow).sale_date;

    const getNumber = (item: AnyDetailRow) =>
        module === 'factures' ? (item as InvDetailRow).invoice_number : (item as ZoneB_DetailRow).quote_number;

    const DEPT_COLORS: Record<string, string> = {
        'MULTI-ANNONCEURS':       'bg-blue-50 text-blue-700 border-blue-100',
        'PROMOTIONNEL':           'bg-purple-50 text-purple-700 border-purple-100',
        'DIST. PUBLICITAIRE SOLO':'bg-orange-50 text-orange-700 border-orange-100',
        'NUMERIQUE':              'bg-cyan-50 text-cyan-700 border-cyan-100',
        'APPLICATION':            'bg-emerald-50 text-emerald-700 border-emerald-100',
        'SERVICES IA':            'bg-rose-50 text-rose-700 border-rose-100',
    };

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    {module === 'factures' ? 'Liste détaillée des factures' : 'Liste détaillée des devis'}
                </h2>
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 uppercase tracking-wider">
                    {lineItems.length} transactions
                </span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                onClick={() => handleSort(dateKey)}
                            >
                                <div className="flex items-center gap-2">
                                    Date <SortIcon order={sortConfig.key === dateKey ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                Statut
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                Client
                            </th>
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap cursor-pointer hover:bg-slate-100 transition-colors group"
                                onClick={() => handleSort('amount')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Montant <SortIcon order={sortConfig.key === 'amount' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                {module === 'factures' ? '# Facture' : '# Devis'}
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                Représentant
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                Département
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={8} className="px-5 py-20 text-center">
                                    <div className="flex flex-col items-center gap-2">
                                        <span className="text-2xl opacity-20">📂</span>
                                        <p className="text-sm text-slate-400 font-medium">Aucun{module === 'factures' ? 'e facture' : ' devis'} trouvé{module === 'factures' ? 'e' : ''} pour ces critères.</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((item, idx) => {
                                const isAvoir = module === 'factures' && (item as InvDetailRow).is_avoir;
                                return (
                                <tr key={`${getNumber(item)}-${idx}`} className={cn("hover:bg-slate-50/60 transition-colors group", isAvoir && "bg-rose-50/30")}>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-slate-400 whitespace-nowrap text-[11px] font-medium">{formatShortDate(getDate(item))}</td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                        {module === 'factures' ? (
                                            <InvStatusBadge status={(item as InvDetailRow).status} isAvoir={isAvoir} />
                                        ) : (
                                        <span className={cn(
                                            "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter",
                                            (item as ZoneB_DetailRow).status === 'invoiced'
                                                ? "bg-emerald-50 text-emerald-600 border border-emerald-100"
                                                : "bg-amber-50 text-amber-600 border border-amber-100"
                                        )}>
                                            {(item as ZoneB_DetailRow).status === 'invoiced' ? 'Facturé' : 'Accepté'}
                                        </span>
                                        )}
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-bold text-slate-800 max-w-[140px] md:max-w-[200px] truncate" title={item.client_name}>
                                        {item.client_name}
                                    </td>
                                    <td className={cn("px-3 md:px-5 py-2.5 md:py-3.5 text-right font-black tabular-nums whitespace-nowrap transition-colors", isAvoir ? "text-rose-600" : "text-slate-900 group-hover:text-brand-main")}>
                                        {formatCurrencyCAD(item.amount)}
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-mono text-[10px] text-slate-400 whitespace-nowrap">{getNumber(item)}</td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-slate-600 whitespace-nowrap font-medium">{item.rep_name}</td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                        <span className={cn(
                                            "inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold whitespace-nowrap border",
                                            DEPT_COLORS[item.department] ?? 'bg-slate-100 text-slate-500 border-slate-200/50'
                                        )}>
                                            {item.department}
                                        </span>
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-center">
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
                                );
                            })
                        )}
                    </tbody>
                    {sortedData.length > 0 && (
                        <tfoot>
                            <tr className="bg-brand-main text-white font-black">
                                <td colSpan={3} className="px-3 md:px-5 py-3 md:py-4 text-[11px] uppercase tracking-widest">Total hebdo.</td>
                                <td className="px-3 md:px-5 py-3 md:py-4 text-right font-black tabular-nums whitespace-nowrap">
                                    {formatCurrencyCAD(totalAmount)}
                                </td>
                                <td colSpan={4} className="px-3 md:px-5 py-3 md:py-4"></td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}

const INV_STATUS_STYLES: Record<string, string> = {
    paid:    'bg-emerald-50 text-emerald-600 border-emerald-100',
    partial: 'bg-blue-50 text-blue-600 border-blue-100',
    sent:    'bg-amber-50 text-amber-600 border-amber-100',
    viewed:  'bg-amber-50 text-amber-600 border-amber-100',
    overdue: 'bg-rose-50 text-rose-600 border-rose-100',
    avoir:   'bg-rose-100 text-rose-700 border-rose-200',
};
const INV_STATUS_LABELS: Record<string, string> = {
    paid: 'Payé', partial: 'Partiel', sent: 'Envoyé',
    viewed: 'Envoyé', overdue: 'En retard', avoir: 'Avoir',
};

function InvStatusBadge({ status, isAvoir }: { status: string; isAvoir: boolean }) {
    const key = isAvoir ? 'avoir' : status;
    return (
        <span className={cn(
            "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter border",
            INV_STATUS_STYLES[key] ?? 'bg-slate-100 text-slate-500 border-slate-200'
        )}>
            {INV_STATUS_LABELS[key] ?? key}
        </span>
    );
}
