import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
    Loader2, DollarSign, CheckCircle2, Clock,
    TrendingUp, Users, Wallet, AlertCircle, Pencil, Check, X,
} from 'lucide-react';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { MONTHS, OFFICES } from '../lib/constants';
import { fetchAllCommRates, saveCommRate } from '../utils/commRates';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepMonthlyData {
    rep_name: string;
    office: string;
    total_amount: number;
    deal_count: number;
    avg_deal: number;
}

// Local state for commission tracking (to be persisted in DB later)
interface PayeRecord {
    rep_name: string;
    taux: number;           // commission rate e.g. 0.05 = 10%
    commission: number;     // calculated
    paid: boolean;
    paid_date: string | null;
    notes: string;
}

// ─── Inline edit for taux ─────────────────────────────────────────────────────

function TauxCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(String(Math.round(value * 100)));

    const commit = () => {
        const n = parseFloat(draft);
        if (!isNaN(n) && n >= 0 && n <= 100) { onSave(n / 100); }
        setEditing(false);
    };

    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <input
                    autoFocus
                    type="number"
                    min={0}
                    max={100}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className="w-16 px-2 py-1 text-xs border border-brand-main rounded-lg focus:outline-none text-center font-semibold"
                />
                <span className="text-xs text-slate-400">%</span>
                <button onClick={commit} className="p-1 text-emerald-500 hover:bg-emerald-50 rounded transition-colors"><Check className="w-3 h-3" /></button>
                <button onClick={() => setEditing(false)} className="p-1 text-slate-400 hover:bg-slate-100 rounded transition-colors"><X className="w-3 h-3" /></button>
            </div>
        );
    }

    return (
        <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 group text-left"
        >
            <span className="text-sm font-bold text-slate-700 tabular-nums">{Math.round(value * 100)}%</span>
            <Pencil className="w-3 h-3 text-slate-300 group-hover:text-brand-main transition-colors opacity-0 group-hover:opacity-100" />
        </button>
    );
}

// ─── Paid status toggle ───────────────────────────────────────────────────────

function PaidToggle({ paid, onToggle }: { paid: boolean; onToggle: () => void }) {
    return (
        <button
            onClick={onToggle}
            className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all border",
                paid
                    ? "bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100"
                    : "bg-slate-50 text-slate-400 border-slate-200 hover:bg-amber-50 hover:text-amber-600 hover:border-amber-200"
            )}
        >
            {paid ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
            {paid ? 'Payé' : 'À payer'}
        </button>
    );
}

// ─── Notes cell ───────────────────────────────────────────────────────────────

function NotesCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);

    const commit = () => { onSave(draft); setEditing(false); };

    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <input
                    autoFocus
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className="w-full min-w-[140px] px-2 py-1 text-xs border border-brand-main rounded-lg focus:outline-none"
                    placeholder="Ajouter une note..."
                />
                <button onClick={commit} className="p-1 text-emerald-500 hover:bg-emerald-50 rounded transition-colors"><Check className="w-3 h-3" /></button>
                <button onClick={() => setEditing(false)} className="p-1 text-slate-400 hover:bg-slate-100 rounded transition-colors"><X className="w-3 h-3" /></button>
            </div>
        );
    }

    return (
        <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 group text-left w-full"
        >
            <span className="text-xs text-slate-400 italic group-hover:text-slate-600 transition-colors truncate max-w-[160px]">
                {value || 'Ajouter une note...'}
            </span>
            <Pencil className="w-3 h-3 text-slate-300 group-hover:text-brand-main transition-colors opacity-0 group-hover:opacity-100 shrink-0" />
        </button>
    );
}

// ─── KPI Summary card ─────────────────────────────────────────────────────────

function KPICard({ title, value, sub, icon: Icon, color }: {
    title: string; value: string; sub: string;
    icon: React.ElementType; color: string;
}) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-2xl border border-slate-100 shadow-card flex flex-col justify-between hover:shadow-card-hover transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className={cn("p-2 md:p-2.5 rounded-xl", color)}>
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
            </div>
            <div>
                <p className="text-[10px] md:text-xs font-semibold text-slate-400 uppercase tracking-widest leading-tight">{title}</p>
                <p className="text-base md:text-2xl font-bold text-slate-900 mt-0.5 md:mt-1 tabular-nums">{value}</p>
                <p className="text-[10px] md:text-[11px] text-slate-400 mt-0.5 md:mt-1 font-medium italic">{sub}</p>
            </div>
        </div>
    );
}

// ─── Month label helper ────────────────────────────────────────────────────────

const MONTH_LABEL: Record<number, string> = {
    1: 'Janvier', 2: 'Février', 3: 'Mars', 4: 'Avril',
    5: 'Mai', 6: 'Juin', 7: 'Juillet', 8: 'Août',
    9: 'Septembre', 10: 'Octobre', 11: 'Novembre', 12: 'Décembre',
};

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Paye() {
    const { isAdmin } = useAuth();

    const [year, setYear] = useState(2026);
    const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
    const [selectedOffice, setSelectedOffice] = useState('Toutes');
    const [loading, setLoading] = useState(false);

    const [repData, setRepData] = useState<RepMonthlyData[]>([]);
    // Paye records keyed by rep_name — in-memory for now (will be persisted in DB later)
    const [payeRecords, setPayeRecords] = useState<Record<string, PayeRecord>>({});

    const monthParam = selectedMonth;
    const officeParam = selectedOffice === 'Toutes' ? null : selectedOffice;

    const fetchData = useCallback(async () => {
        setLoading(true);
        const { data } = await supabase.rpc('get_inv_rep_leaderboard', {
            p_year: year,
            p_office: officeParam,
            p_status: null,
            p_month: monthParam,
            p_dept: null,
            p_rep: null,
        });
        const rows: RepMonthlyData[] = (data || []) as RepMonthlyData[];
        setRepData(rows);

        // Initialize paye records — read persisted rates from Supabase
        const savedRates = await fetchAllCommRates();
        setPayeRecords(prev => {
            const next = { ...prev };
            for (const r of rows) {
                const taux = savedRates[r.rep_name] ?? next[r.rep_name]?.taux ?? 0.05;
                if (!next[r.rep_name]) {
                    next[r.rep_name] = {
                        rep_name: r.rep_name,
                        taux,
                        commission: r.total_amount * taux,
                        paid: false,
                        paid_date: null,
                        notes: '',
                    };
                } else {
                    // Refresh commission with latest facturé total + current rate
                    next[r.rep_name] = {
                        ...next[r.rep_name],
                        taux,
                        commission: r.total_amount * taux,
                    };
                }
            }
            return next;
        });

        setLoading(false);
    }, [year, officeParam, monthParam]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // Helpers to update paye records
    const setTaux = (rep: string, taux: number) => {
        saveCommRate(rep, taux); // persist to Supabase
        setPayeRecords(prev => {
            const r = repData.find(d => d.rep_name === rep);
            const total = r?.total_amount ?? 0;
            return { ...prev, [rep]: { ...prev[rep], taux, commission: total * taux } };
        });
    };
    const togglePaid = (rep: string) => {
        setPayeRecords(prev => ({
            ...prev,
            [rep]: {
                ...prev[rep],
                paid: !prev[rep]?.paid,
                paid_date: !prev[rep]?.paid ? new Date().toLocaleDateString('fr-CA') : null,
            },
        }));
    };
    const setNotes = (rep: string, notes: string) => {
        setPayeRecords(prev => ({ ...prev, [rep]: { ...prev[rep], notes } }));
    };

    // Summary KPIs
    const totalFacture = repData.reduce((s, r) => s + r.total_amount, 0);
    const totalCommission = repData.reduce((s, r) => s + (payeRecords[r.rep_name]?.commission ?? r.total_amount * 0.05), 0);
    const paidCount = Object.values(payeRecords).filter(p => p.paid && repData.some(r => r.rep_name === p.rep_name)).length;
    const pendingCount = repData.length - paidCount;

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = MONTHS.map(m => ({ value: String(m.value), label: m.label }));
    const officeOptions = [{ value: 'Toutes', label: 'Tous les sièges' }, ...OFFICES];

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-slate-400 text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">

            {/* ─── Header ─── */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
                        Paye des Représentants
                    </h1>
                    <p className="text-sm text-slate-400 mt-0.5">
                        Suivi des commissions · {MONTH_LABEL[selectedMonth]} {year}
                    </p>
                </div>

                {/* Period badge */}
                <div className="flex items-center gap-2 px-4 py-2 bg-brand-main/5 border border-brand-main/20 rounded-xl">
                    <DollarSign className="w-4 h-4 text-brand-main" />
                    <span className="text-sm font-bold text-brand-main">{MONTH_LABEL[selectedMonth]} {year}</span>
                </div>
            </div>

            {/* ─── Filters ─── */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={String(selectedMonth)} onChange={v => setSelectedMonth(Number(v))} options={monthOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
            </FilterBar>

            {/* ─── Summary KPIs ─── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KPICard
                    title="Total Facturé"
                    value={formatCurrencyCAD(totalFacture)}
                    sub={`${repData.length} représentants actifs`}
                    icon={TrendingUp}
                    color="bg-blue-50 text-blue-500"
                />
                <KPICard
                    title="Commissions Totales"
                    value={formatCurrencyCAD(totalCommission)}
                    sub="Basé sur les taux individuels"
                    icon={Wallet}
                    color="bg-brand-main/10 text-brand-main"
                />
                <KPICard
                    title="Reps Payés"
                    value={String(paidCount)}
                    sub={`sur ${repData.length} représentants`}
                    icon={CheckCircle2}
                    color="bg-emerald-50 text-emerald-500"
                />
                <KPICard
                    title="En Attente"
                    value={String(pendingCount)}
                    sub={`${formatCurrencyCAD(
                        repData
                            .filter(r => !payeRecords[r.rep_name]?.paid)
                            .reduce((s, r) => s + (payeRecords[r.rep_name]?.commission ?? r.total_amount * 0.05), 0)
                    )} à payer`}
                    icon={AlertCircle}
                    color="bg-amber-50 text-amber-500"
                />
            </div>

            {/* ─── Main Table ─── */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-400" />
                    <h3 className="text-sm font-bold text-slate-800">Suivi des paiements</h3>
                    <span className="ml-auto text-xs text-slate-400 italic">
                        Les taux sont sauvegardés dans la base de données
                    </span>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-16 gap-2">
                        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                        <span className="text-sm text-slate-400">Chargement...</span>
                    </div>
                ) : repData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-2">
                        <Users className="w-8 h-8 text-slate-200" />
                        <p className="text-sm text-slate-400">Aucune donnée pour cette période</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-100 bg-slate-50/60">
                                    <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Représentant</th>
                                    <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Siège</th>
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Facturé</th>
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Nb Fact.</th>
                                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">Taux</th>
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Commission</th>
                                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">Statut</th>
                                    <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date payé</th>
                                    <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Notes</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {repData.map((rep) => {
                                    const paye = payeRecords[rep.rep_name] ?? {
                                        taux: 0.05, commission: rep.total_amount * 0.05,
                                        paid: false, paid_date: null, notes: '',
                                    };
                                    return (
                                        <tr
                                            key={rep.rep_name}
                                            className={cn(
                                                "hover:bg-slate-50/60 transition-colors",
                                                paye.paid && "bg-emerald-50/20"
                                            )}
                                        >
                                            {/* Rep name */}
                                            <td className="px-5 py-3">
                                                <div className="flex items-center gap-3">
                                                    <div className={cn(
                                                        "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                                                        paye.paid
                                                            ? "bg-emerald-100 text-emerald-600"
                                                            : "bg-brand-main/10 text-brand-main"
                                                    )}>
                                                        {rep.rep_name.charAt(0)}
                                                    </div>
                                                    <span className="font-semibold text-slate-800">{rep.rep_name}</span>
                                                </div>
                                            </td>

                                            {/* Office */}
                                            <td className="px-4 py-3">
                                                <span className="text-[10px] font-bold text-slate-400 uppercase bg-slate-100 px-2 py-0.5 rounded-full">
                                                    {rep.office}
                                                </span>
                                            </td>

                                            {/* Facturé */}
                                            <td className="px-4 py-3 text-right font-bold text-slate-900 tabular-nums">
                                                {formatCurrencyCAD(rep.total_amount)}
                                            </td>

                                            {/* Nb factures */}
                                            <td className="px-4 py-3 text-right text-slate-500 tabular-nums">
                                                {rep.deal_count}
                                            </td>

                                            {/* Taux commission */}
                                            <td className="px-4 py-3 text-center">
                                                <TauxCell value={paye.taux} onSave={v => setTaux(rep.rep_name, v)} />
                                            </td>

                                            {/* Commission calculée */}
                                            <td className="px-4 py-3 text-right">
                                                <span className="font-bold text-brand-main tabular-nums text-sm">
                                                    {formatCurrencyCAD(paye.commission)}
                                                </span>
                                            </td>

                                            {/* Statut payé */}
                                            <td className="px-4 py-3 text-center">
                                                <PaidToggle paid={paye.paid} onToggle={() => togglePaid(rep.rep_name)} />
                                            </td>

                                            {/* Date payé */}
                                            <td className="px-4 py-3">
                                                {paye.paid && paye.paid_date ? (
                                                    <span className="text-xs text-emerald-600 font-medium">{paye.paid_date}</span>
                                                ) : (
                                                    <span className="text-xs text-slate-300">—</span>
                                                )}
                                            </td>

                                            {/* Notes */}
                                            <td className="px-4 py-3">
                                                <NotesCell value={paye.notes} onSave={v => setNotes(rep.rep_name, v)} />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>

                            {/* Footer totals */}
                            <tfoot>
                                <tr className="border-t-2 border-slate-200 bg-slate-50/80">
                                    <td colSpan={2} className="px-5 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                                        Total — {repData.length} reps
                                    </td>
                                    <td className="px-4 py-3 text-right font-bold text-slate-900 tabular-nums">
                                        {formatCurrencyCAD(totalFacture)}
                                    </td>
                                    <td className="px-4 py-3 text-right text-slate-500 tabular-nums font-bold">
                                        {repData.reduce((s, r) => s + r.deal_count, 0)}
                                    </td>
                                    <td className="px-4 py-3" />
                                    <td className="px-4 py-3 text-right font-bold text-brand-main tabular-nums">
                                        {formatCurrencyCAD(totalCommission)}
                                    </td>
                                    <td colSpan={3} className="px-4 py-3">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-bold text-emerald-600 uppercase">
                                                {paidCount} payés
                                            </span>
                                            {pendingCount > 0 && (
                                                <>
                                                    <span className="text-slate-300">·</span>
                                                    <span className="text-[10px] font-bold text-amber-500 uppercase">
                                                        {pendingCount} en attente
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}
            </div>

        </div>
    );
}
