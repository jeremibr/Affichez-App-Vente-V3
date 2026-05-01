import { useState, useEffect, useCallback } from 'react';
import { Target, Loader2, Check, X, Pencil, User } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepObjective {
    id?: number;
    rep_name: string;
    module: 'devis' | 'factures';
    year: number;
    month: number;
    target_amount: number;
}

interface MonthRow {
    month: number;
    label: string;
    devisTarget: number;
    devisActual: number;
    facturesTarget: number;
    facturesActual: number;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props { propRepName?: string; }

// ─── Months ───────────────────────────────────────────────────────────────────

const MONTH_LABELS = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

// ─── Inline target editor ─────────────────────────────────────────────────────

function TargetCell({
    value, onSave, readOnly,
}: { value: number; onSave: (v: number) => void; readOnly?: boolean }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');

    const commit = () => {
        const n = parseFloat(draft.replace(/[$,\s]/g, '')) || 0;
        onSave(n);
        setEditing(false);
    };

    if (editing) {
        return (
            <div className="flex items-center gap-1 justify-end">
                <input
                    autoFocus
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className="w-28 px-2 py-1 text-xs border border-brand-main rounded-lg focus:outline-none text-right font-semibold"
                    placeholder="0"
                />
                <button onClick={commit} className="p-1 text-emerald-500 hover:bg-emerald-50 rounded transition-colors">
                    <Check className="w-3 h-3" />
                </button>
                <button onClick={() => setEditing(false)} className="p-1 text-slate-400 hover:bg-slate-100 rounded transition-colors">
                    <X className="w-3 h-3" />
                </button>
            </div>
        );
    }

    if (readOnly) {
        return (
            <span className="text-sm font-semibold text-slate-700 tabular-nums">
                {value > 0 ? formatCurrencyCAD(value) : <span className="text-slate-200">—</span>}
            </span>
        );
    }

    return (
        <button
            onClick={() => { setDraft(value > 0 ? String(value) : ''); setEditing(true); }}
            className="flex items-center gap-1 group ml-auto text-right"
        >
            <span className="text-sm font-semibold text-slate-700 tabular-nums">
                {value > 0 ? formatCurrencyCAD(value) : <span className="text-slate-300">Fixer</span>}
            </span>
            <Pencil className="w-3 h-3 text-slate-300 group-hover:text-brand-main transition-colors opacity-0 group-hover:opacity-100" />
        </button>
    );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function Progress({ actual, target }: { actual: number; target: number }) {
    if (target <= 0) return <span className="text-slate-300 text-xs">—</span>;
    const pct = Math.min(Math.round((actual / target) * 100), 150);
    const color = pct >= 100 ? 'bg-emerald-400' : pct >= 70 ? 'bg-amber-400' : 'bg-red-400';
    return (
        <div className="flex items-center gap-2 min-w-[80px]">
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                    className={cn("h-full rounded-full transition-all", color)}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                />
            </div>
            <span className={cn(
                "text-xs font-bold tabular-nums w-9 text-right",
                pct >= 100 ? 'text-emerald-600' : pct >= 70 ? 'text-amber-600' : 'text-red-500'
            )}>
                {pct}%
            </span>
        </div>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortailObjectifs({ propRepName }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const canEdit = isAdmin; // admins can set targets; reps see read-only

    const [year, setYear] = useState(2026);
    const [loading, setLoading] = useState(true);
    const [rows, setRows] = useState<MonthRow[]>([]);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    // ─── Fetch ───────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);

        const [objRes, devisRes, factRes] = await Promise.all([
            supabase
                .from('rep_objectives')
                .select('*')
                .eq('rep_name', repName)
                .eq('year', year),
            supabase.rpc('get_sommaire_grand_total', {
                p_year: year, p_office: null, p_status: null, p_rep: repName,
            }),
            supabase.rpc('get_inv_sommaire_grand_total', {
                p_year: year, p_office: null, p_status: null, p_rep: repName,
            }),
        ]);

        const objectives = (objRes.data ?? []) as RepObjective[];
        const devisActuals = (devisRes.data ?? []) as { month: number; actual_amount: number }[];
        const factActuals  = (factRes.data ?? [])  as { month: number; actual_amount: number }[];

        const objMap: Record<string, number> = {};
        for (const o of objectives) { objMap[`${o.module}-${o.month}`] = o.target_amount; }

        const devisMap: Record<number, number> = {};
        for (const d of devisActuals) { devisMap[d.month] = d.actual_amount; }

        const factMap: Record<number, number> = {};
        for (const f of factActuals) { factMap[f.month] = f.actual_amount; }

        setRows(
            MONTH_LABELS.map((label, i) => ({
                month: i + 1,
                label,
                devisTarget:    objMap[`devis-${i + 1}`]    ?? 0,
                devisActual:    devisMap[i + 1]              ?? 0,
                facturesTarget: objMap[`factures-${i + 1}`] ?? 0,
                facturesActual: factMap[i + 1]               ?? 0,
            }))
        );

        setLoading(false);
    }, [repName, year]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── Save a single target ─────────────────────────────────────────────────

    const saveTarget = async (month: number, module: 'devis' | 'factures', target_amount: number) => {
        await supabase
            .from('rep_objectives')
            .upsert(
                { rep_name: repName, module, year, month, target_amount, updated_at: new Date().toISOString() },
                { onConflict: 'rep_name,module,year,month' }
            );
        setRows(prev => prev.map(r =>
            r.month === month
                ? { ...r, [`${module}Target`]: target_amount }
                : r
        ));
    };

    // ─── Totals ───────────────────────────────────────────────────────────────

    const totals = rows.reduce(
        (acc, r) => ({
            devisTarget:    acc.devisTarget    + r.devisTarget,
            devisActual:    acc.devisActual    + r.devisActual,
            facturesTarget: acc.facturesTarget + r.facturesTarget,
            facturesActual: acc.facturesActual + r.facturesActual,
        }),
        { devisTarget: 0, devisActual: 0, facturesTarget: 0, facturesActual: 0 }
    );

    // ─── Render ───────────────────────────────────────────────────────────────

    if (!repName && !isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-2xl mx-auto flex items-center justify-center min-h-[60vh]">
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto">
                        <User className="w-7 h-7 text-slate-300" />
                    </div>
                    <h2 className="text-base font-semibold text-slate-700">Portail non configuré</h2>
                    <p className="text-sm text-slate-400 max-w-xs">Votre compte n'est pas encore associé à un représentant. Contactez un administrateur pour configurer votre accès.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-5 md:space-y-6">

            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                        <Target className="w-5 h-5 text-brand-main" />
                        Mes Objectifs
                    </h2>
                    <p className="text-sm text-slate-400 mt-0.5">
                        Suivi objectifs mensuels · {repName || 'Représentant'}
                        {canEdit && <span className="ml-2 text-[10px] font-bold text-brand-main uppercase tracking-widest">Cliquer pour modifier</span>}
                    </p>
                </div>
            </div>

            {/* Filters */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
            </FilterBar>

            {/* Table */}
            {!repName ? (
                <div className="flex flex-col items-center justify-center py-20 gap-2">
                    <Target className="w-8 h-8 text-slate-200" />
                    <p className="text-sm text-slate-400">Sélectionnez un représentant ci-dessus</p>
                </div>
            ) : loading ? (
                <div className="flex items-center justify-center py-20 gap-2">
                    <Loader2 className="w-6 h-6 animate-spin text-slate-300" />
                    <span className="text-sm text-slate-400">Chargement...</span>
                </div>
            ) : (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-slate-100 bg-slate-50/60">
                                <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Mois</th>

                                {/* Devis columns */}
                                <th className="px-4 py-3 text-right text-[10px] font-bold text-blue-400 uppercase tracking-widest">Objectif Devis</th>
                                <th className="px-4 py-3 text-right text-[10px] font-bold text-blue-400 uppercase tracking-widest">Réalisé</th>
                                <th className="px-4 py-3 text-right text-[10px] font-bold text-blue-300 uppercase tracking-widest min-w-[120px]">Atteinte</th>

                                {/* Separator */}
                                <th className="w-px bg-slate-100" />

                                {/* Factures columns */}
                                <th className="px-4 py-3 text-right text-[10px] font-bold text-amber-500 uppercase tracking-widest">Objectif Factures</th>
                                <th className="px-4 py-3 text-right text-[10px] font-bold text-amber-500 uppercase tracking-widest">Réalisé</th>
                                <th className="px-4 py-3 text-right text-[10px] font-bold text-amber-400 uppercase tracking-widest min-w-[120px]">Atteinte</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {rows.map((row, idx) => (
                                <tr key={row.month} className={cn(
                                    "hover:bg-slate-50/60 transition-colors",
                                    idx % 2 === 1 && "bg-slate-50/20"
                                )}>
                                    <td className="px-5 py-3 font-semibold text-slate-700">{row.label}</td>

                                    {/* Devis */}
                                    <td className="px-4 py-3 text-right">
                                        <TargetCell
                                            value={row.devisTarget}
                                            onSave={v => saveTarget(row.month, 'devis', v)}
                                            readOnly={!canEdit}
                                        />
                                    </td>
                                    <td className="px-4 py-3 text-right font-semibold text-blue-700 tabular-nums">
                                        {row.devisActual > 0 ? formatCurrencyCAD(row.devisActual) : <span className="text-slate-200">—</span>}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Progress actual={row.devisActual} target={row.devisTarget} />
                                    </td>

                                    {/* Separator */}
                                    <td className="w-px bg-slate-100 p-0" />

                                    {/* Factures */}
                                    <td className="px-4 py-3 text-right">
                                        <TargetCell
                                            value={row.facturesTarget}
                                            onSave={v => saveTarget(row.month, 'factures', v)}
                                            readOnly={!canEdit}
                                        />
                                    </td>
                                    <td className="px-4 py-3 text-right font-semibold text-amber-700 tabular-nums">
                                        {row.facturesActual > 0 ? formatCurrencyCAD(row.facturesActual) : <span className="text-slate-200">—</span>}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Progress actual={row.facturesActual} target={row.facturesTarget} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-slate-200 bg-slate-50/80">
                                <td className="px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-widest">Total {year}</td>

                                {/* Devis totals */}
                                <td className="px-4 py-3 text-right font-bold text-slate-800 tabular-nums">
                                    {totals.devisTarget > 0 ? formatCurrencyCAD(totals.devisTarget) : <span className="text-slate-300">—</span>}
                                </td>
                                <td className="px-4 py-3 text-right font-bold text-blue-700 tabular-nums">
                                    {totals.devisActual > 0 ? formatCurrencyCAD(totals.devisActual) : <span className="text-slate-300">—</span>}
                                </td>
                                <td className="px-4 py-3">
                                    <Progress actual={totals.devisActual} target={totals.devisTarget} />
                                </td>

                                <td className="w-px bg-slate-200 p-0" />

                                {/* Factures totals */}
                                <td className="px-4 py-3 text-right font-bold text-slate-800 tabular-nums">
                                    {totals.facturesTarget > 0 ? formatCurrencyCAD(totals.facturesTarget) : <span className="text-slate-300">—</span>}
                                </td>
                                <td className="px-4 py-3 text-right font-bold text-amber-700 tabular-nums">
                                    {totals.facturesActual > 0 ? formatCurrencyCAD(totals.facturesActual) : <span className="text-slate-300">—</span>}
                                </td>
                                <td className="px-4 py-3">
                                    <Progress actual={totals.facturesActual} target={totals.facturesTarget} />
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
            )}
        </div>
    );
}
