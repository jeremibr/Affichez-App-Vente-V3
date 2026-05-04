import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import {
    Loader2, ChevronLeft, ChevronRight, TrendingUp,
    DollarSign, FileText, MinusCircle, ClipboardList,
} from 'lucide-react';
import { formatCurrencyCAD, cn } from '../../lib/utils';
import { DEPARTMENTS } from '../../lib/constants';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvoiceRow {
    zoho_id: string;
    invoice_number: string;
    invoice_date: string;
    client_name: string;
    amount: number;
    department: string;
    rep_name: string | null;
    status: string;
    is_avoir: boolean;
}

interface SaleRow {
    zoho_id: string;
    quote_number: string;
    sale_date: string;
    client_name: string;
    amount: number;
    department: string;
    rep_name: string | null;
    status: string;
}

type Row = InvoiceRow | SaleRow;

interface DeptSummary {
    department: string;
    total: number;
    commission: number;
    count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_FULL = [
    '', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
const MONTH_SHORT = [
    '', 'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
    'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc',
];

function prevMonth(y: number, m: number) { return m === 1 ? [y - 1, 12] : [y, m - 1]; }
function nextMonth(y: number, m: number) { return m === 12 ? [y + 1, 1] : [y, m + 1]; }

function paddedMonth(m: number) { return String(m).padStart(2, '0'); }

function isSaleRow(r: Row): r is SaleRow {
    return 'quote_number' in r;
}

function getDate(r: Row) { return isSaleRow(r) ? (r as SaleRow).sale_date : (r as InvoiceRow).invoice_date; }
function getRef(r: Row)  { return isSaleRow(r) ? (r as SaleRow).quote_number : (r as InvoiceRow).invoice_number; }
function isAvoir(r: Row) { return !isSaleRow(r) && (r as InvoiceRow).is_avoir; }

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
    module: 'devis' | 'factures';
    repName?: string | null;    // null / undefined → all reps
    commRate?: number;           // default 0.05
    initialYear?: number;
    initialMonth?: number;
    compact?: boolean;           // hide dept breakdown when embedded in a tight space
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MonthlyDetail({
    module,
    repName,
    commRate = 0.05,
    initialYear,
    initialMonth,
    compact = false,
}: Props) {
    const now = new Date();
    const [year,  setYear]  = useState(initialYear  ?? now.getFullYear());
    const [month, setMonth] = useState(initialMonth ?? now.getMonth() + 1);
    const [rows,  setRows]  = useState<Row[]>([]);
    const [loading, setLoading] = useState(true);

    // Sync if parent changes initialYear / initialMonth (portail year filter)
    useEffect(() => {
        if (initialYear  !== undefined) setYear(initialYear);
    }, [initialYear]);
    useEffect(() => {
        if (initialMonth !== undefined) setMonth(initialMonth);
    }, [initialMonth]);

    const fetchRows = useCallback(async () => {
        setLoading(true);
        const dateStart = `${year}-${paddedMonth(month)}-01`;
        const [ny, nm] = nextMonth(year, month);
        const dateEnd   = `${ny}-${paddedMonth(nm)}-01`;

        if (module === 'factures') {
            let q = supabase
                .from('invoices')
                .select('zoho_id,invoice_number,invoice_date,client_name,amount,department,rep_name,status,is_avoir')
                .gte('invoice_date', dateStart)
                .lt('invoice_date', dateEnd)
                .order('invoice_date', { ascending: true });
            if (repName) q = q.eq('rep_name', repName);
            const { data } = await q;
            setRows((data ?? []) as InvoiceRow[]);
        } else {
            let q = supabase
                .from('sales')
                .select('zoho_id,quote_number,sale_date,client_name,amount,department,rep_name,status')
                .gte('sale_date', dateStart)
                .lt('sale_date', dateEnd)
                .order('sale_date', { ascending: true });
            if (repName) q = q.eq('rep_name', repName);
            const { data } = await q;
            setRows((data ?? []) as SaleRow[]);
        }
        setLoading(false);
    }, [module, repName, year, month]);

    useEffect(() => { fetchRows(); }, [fetchRows]);

    // ─── Derived values ───────────────────────────────────────────────────────

    const regularRows = rows.filter(r => !isAvoir(r));
    const avoirRows   = rows.filter(r => isAvoir(r));

    const totalVentes     = regularRows.reduce((s, r) => s + r.amount, 0);
    const totalAvoirs     = avoirRows.reduce((s, r)   => s + r.amount, 0); // already negative
    const totalNet        = totalVentes + totalAvoirs;
    // Commission is based on net revenue (avoirs reduce the commission base)
    const totalCommission = totalNet * commRate;

    // Department breakdown — include avoirs so dept totals are net
    const deptMap = new Map<string, DeptSummary>();
    for (const dept of DEPARTMENTS) {
        deptMap.set(dept, { department: dept, total: 0, commission: 0, count: 0 });
    }
    for (const r of rows) {
        const avoir = isAvoir(r);
        const key = r.department ?? '';
        const cur = deptMap.get(key) ?? { department: key, total: 0, commission: 0, count: 0 };
        cur.total += r.amount; // avoirs are negative — naturally subtract
        if (!avoir) { cur.commission += r.amount * commRate; cur.count++; }
        deptMap.set(key, cur);
    }
    // Recalculate dept commissions on net totals to be consistent
    for (const [key, d] of deptMap) {
        d.commission = d.total * commRate;
        deptMap.set(key, d);
    }
    const deptSummaries = [...deptMap.values()].filter(d => d.total !== 0);

    // Navigation
    const [py, pm] = prevMonth(year, month);
    const [ny, nm] = nextMonth(year, month);
    const isFuture = ny > now.getFullYear() || (ny === now.getFullYear() && nm > now.getMonth() + 1);

    const goTo = (y: number, m: number) => { setYear(y); setMonth(m); };

    const isFactures = module === 'factures';

    return (
        <div className="space-y-4">

            {/* ─── Month navigation ─── */}
            <div className="flex items-center justify-between bg-white rounded-2xl border border-slate-100 shadow-card px-5 py-3">
                <button
                    onClick={() => goTo(py, pm)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-50 text-sm font-medium transition-all"
                >
                    <ChevronLeft className="w-4 h-4" />
                    {MONTH_SHORT[pm]} {py}
                </button>

                <div className="text-center">
                    <h3 className="text-base font-bold text-slate-900">
                        {MONTH_FULL[month]} {year}
                    </h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5">
                        {isFactures ? 'Détail des factures' : 'Détail des devis'}
                        {repName ? ` · ${repName}` : ''}
                    </p>
                </div>

                <button
                    onClick={() => goTo(ny, nm)}
                    disabled={isFuture}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                        isFuture
                            ? "text-slate-200 cursor-not-allowed"
                            : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                    )}
                >
                    {MONTH_SHORT[nm]} {ny}
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-16 gap-3 bg-white rounded-2xl border border-slate-100">
                    <Loader2 className="w-5 h-5 animate-spin text-brand-main" />
                    <span className="text-sm text-slate-400">Chargement de {MONTH_FULL[month]}...</span>
                </div>
            ) : rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 bg-white rounded-2xl border border-slate-100">
                    {isFactures
                        ? <FileText className="w-8 h-8 text-slate-200" />
                        : <ClipboardList className="w-8 h-8 text-slate-200" />
                    }
                    <p className="text-sm text-slate-400">
                        Aucune {isFactures ? 'facture' : 'vente'} en {MONTH_FULL[month]} {year}
                    </p>
                </div>
            ) : (
                <>
                {/* ─── Summary KPIs ─── */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <SummaryCard
                        icon={TrendingUp}
                        label={isFactures ? 'Total Facturé' : 'Total Ventes'}
                        value={formatCurrencyCAD(totalNet)}
                        sub={`${regularRows.length} ${isFactures ? 'factures' : 'devis'}${avoirRows.length > 0 ? ` · ${avoirRows.length} avoir${avoirRows.length > 1 ? 's' : ''}` : ''}`}
                        color="bg-blue-50 text-blue-500"
                    />
                    <SummaryCard
                        icon={DollarSign}
                        label="Commission"
                        value={formatCurrencyCAD(totalCommission)}
                        sub={`Taux: ${Math.round(commRate * 100)}%`}
                        color="bg-brand-main/10 text-brand-main"
                    />
                    <SummaryCard
                        icon={TrendingUp}
                        label="Avant avoirs"
                        value={formatCurrencyCAD(totalVentes)}
                        sub={totalAvoirs !== 0 ? `dont ${formatCurrencyCAD(totalAvoirs)} avoirs` : 'Aucun avoir'}
                        color="bg-slate-50 text-slate-500"
                    />
                    <SummaryCard
                        icon={MinusCircle}
                        label="Avoirs"
                        value={formatCurrencyCAD(totalAvoirs)}
                        sub={`${avoirRows.length} note${avoirRows.length > 1 ? 's' : ''} de crédit`}
                        color={totalAvoirs < 0 ? "bg-red-50 text-red-400" : "bg-slate-50 text-slate-400"}
                    />
                </div>

                {/* ─── Department breakdown ─── */}
                {!compact && deptSummaries.length > 0 && (
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                        <div className="px-5 py-3.5 border-b border-slate-100">
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Par département</h4>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-slate-50 bg-slate-50/40">
                                        <th className="px-5 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Département</th>
                                        <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Ventes</th>
                                        <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Commission</th>
                                        <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Qty</th>
                                        <th className="px-5 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">% du total</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                    {deptSummaries.map(d => (
                                        <tr key={d.department} className="hover:bg-slate-50/60 transition-colors">
                                            <td className="px-5 py-2.5">
                                                <span className="text-xs font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                                    {d.department}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-bold text-slate-800 tabular-nums">
                                                {formatCurrencyCAD(d.total)}
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-bold text-brand-main tabular-nums">
                                                {formatCurrencyCAD(d.commission)}
                                            </td>
                                            <td className="px-4 py-2.5 text-right text-slate-500 tabular-nums">
                                                {d.count}
                                            </td>
                                            <td className="px-5 py-2.5">
                                                <div className="flex items-center justify-end gap-2">
                                                    <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-brand-main rounded-full"
                                                            style={{ width: `${totalNet > 0 ? Math.min((d.total / totalNet) * 100, 100) : 0}%` }}
                                                        />
                                                    </div>
                                                    <span className="text-xs font-semibold text-slate-400 w-8 text-right tabular-nums">
                                                        {totalNet > 0 ? Math.round((d.total / totalNet) * 100) : 0}%
                                                    </span>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                    {/* Total row */}
                                    <tr className="border-t-2 border-slate-200 bg-slate-50/80">
                                        <td className="px-5 py-2.5 text-xs font-bold text-slate-600 uppercase tracking-wide">Total</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-slate-900 tabular-nums">{formatCurrencyCAD(totalNet)}</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-brand-main tabular-nums">{formatCurrencyCAD(totalCommission)}</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-slate-600 tabular-nums">{regularRows.length}</td>
                                        <td className="px-5 py-2.5" />
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ─── Line items ─── */}
                <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                            Détail — {rows.length} transaction{rows.length > 1 ? 's' : ''}
                        </h4>
                        {avoirRows.length > 0 && (
                            <span className="text-[10px] font-bold text-red-400 bg-red-50 px-2 py-0.5 rounded-full">
                                {avoirRows.length} avoir{avoirRows.length > 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-50 bg-slate-50/40">
                                    <th className="px-5 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Client</th>
                                    <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Montant HT</th>
                                    <th className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                        {isFactures ? '# Facture' : '# Devis'}
                                    </th>
                                    <th className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date</th>
                                    <th className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Département</th>
                                    <th className="px-5 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Commission</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {rows.map(r => {
                                    const avoir = isAvoir(r);
                                    // Avoirs don't generate commission
                                    const comm  = avoir ? 0 : r.amount * commRate;
                                    const dateStr = getDate(r);
                                    const formattedDate = dateStr
                                        ? new Date(dateStr).toLocaleDateString('fr-CA', { day: '2-digit', month: '2-digit' })
                                        : '—';

                                    return (
                                        <tr
                                            key={r.zoho_id}
                                            className={cn(
                                                "transition-colors",
                                                avoir
                                                    ? "bg-red-50/40 hover:bg-red-50/70"
                                                    : "hover:bg-slate-50/60"
                                            )}
                                        >
                                            <td className="px-3 md:px-5 py-2 md:py-2.5 max-w-[120px] md:max-w-[200px]">
                                                <p className={cn("font-semibold truncate text-sm", avoir ? "text-red-700" : "text-slate-800")} title={r.client_name}>
                                                    {r.client_name}
                                                </p>
                                                {avoir && (
                                                    <span className="text-[9px] font-bold text-red-400 uppercase tracking-wide">Avoir</span>
                                                )}
                                            </td>
                                            <td className={cn("px-4 py-2.5 text-right font-bold tabular-nums", avoir ? "text-red-600" : "text-slate-900")}>
                                                {formatCurrencyCAD(r.amount)}
                                            </td>
                                            <td className="px-4 py-2.5">
                                                <span className={cn("text-xs font-mono font-semibold", avoir ? "text-red-500" : "text-slate-500")}>
                                                    {getRef(r)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2.5 text-xs text-slate-500 tabular-nums">
                                                {formattedDate}
                                            </td>
                                            <td className="px-4 py-2.5">
                                                <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                                                    {r.department}
                                                </span>
                                            </td>
                                            <td className={cn("px-5 py-2.5 text-right font-bold tabular-nums", avoir ? "text-red-500" : "text-brand-main")}>
                                                {formatCurrencyCAD(comm)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            {/* Footer */}
                            <tfoot>
                                <tr className="border-t-2 border-slate-200 bg-slate-50/80">
                                    <td className="px-5 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wide">
                                        Total — {rows.length} lignes
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-bold text-slate-900 tabular-nums">
                                        {formatCurrencyCAD(totalNet)}
                                    </td>
                                    <td colSpan={3} />
                                    <td className="px-5 py-2.5 text-right font-bold text-brand-main tabular-nums">
                                        {formatCurrencyCAD(totalCommission)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
                </>
            )}
        </div>
    );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, sub, color }: {
    icon: React.ElementType; label: string; value: string; sub: string; color: string;
}) {
    return (
        <div className="bg-white p-3 md:p-4 rounded-2xl border border-slate-100 shadow-card hover:shadow-card-hover transition-all">
            <div className={cn("w-7 h-7 md:w-8 md:h-8 rounded-xl flex items-center justify-center mb-2 md:mb-3", color)}>
                <Icon className="w-3.5 h-3.5 md:w-4 md:h-4" />
            </div>
            <p className="text-[9px] md:text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-tight">{label}</p>
            <p className="text-sm md:text-xl font-bold text-slate-900 mt-0.5 tabular-nums">{value}</p>
            <p className="text-[9px] md:text-[10px] text-slate-400 mt-0.5 italic leading-tight">{sub}</p>
        </div>
    );
}
