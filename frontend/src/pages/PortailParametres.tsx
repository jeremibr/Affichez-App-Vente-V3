import { useState, useEffect, useCallback } from 'react';
import { useUrlStateNumber } from '../hooks/useUrlState';
import { Settings, Loader2, Check, X, Save, User, ClipboardList, FileText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { Select } from '../components/Select';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepObjective {
    rep_name: string;
    module: 'devis' | 'factures';
    year: number;
    month: number;
    target_amount: number;
}

interface Props { propRepName?: string; }

const MONTH_LABELS = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

// ─── Inline target cell ───────────────────────────────────────────────────────

function TargetCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');

    const commit = () => {
        const n = parseFloat(draft.replace(/[^0-9.]/g, '')) || 0;
        onSave(n);
        setEditing(false);
    };

    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <input
                    autoFocus
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className="w-28 px-2.5 py-1.5 text-sm border border-brand-main rounded-lg focus:outline-none text-right font-semibold bg-white"
                    placeholder="0"
                />
                <button onClick={commit} className="p-1.5 text-emerald-500 hover:bg-emerald-50 rounded-lg transition-colors">
                    <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setEditing(false)} className="p-1.5 text-slate-300 hover:bg-slate-100 rounded-lg transition-colors">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        );
    }

    return (
        <button
            onClick={() => { setDraft(value > 0 ? String(value) : ''); setEditing(true); }}
            className={cn(
                "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-all text-right group",
                value > 0
                    ? "bg-slate-50 hover:bg-brand-main/5 hover:text-brand-main text-slate-700"
                    : "bg-slate-50 hover:bg-brand-main/5 text-slate-300 hover:text-brand-main"
            )}
        >
            <Save className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-brand-main shrink-0" />
            <span className="flex-1 text-right tabular-nums">
                {value > 0 ? formatCurrencyCAD(value) : 'Fixer objectif'}
            </span>
        </button>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortailParametres({ propRepName }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const [year, setYear] = useUrlStateNumber('year', new Date().getFullYear());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [objectives, setObjectives] = useState<Record<string, number>>({});

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    // ─── Fetch ───────────────────────────────────────────────────────────────

    const fetchObjectives = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);
        const { data } = await supabase
            .from('rep_objectives')
            .select('module, month, target_amount')
            .eq('rep_name', repName)
            .eq('year', year);

        const map: Record<string, number> = {};
        for (const o of (data ?? []) as RepObjective[]) {
            map[`${o.module}-${o.month}`] = o.target_amount;
        }
        setObjectives(map);
        setLoading(false);
    }, [repName, year]);

    useEffect(() => { fetchObjectives(); }, [fetchObjectives]);

    // ─── Save ─────────────────────────────────────────────────────────────────

    const saveTarget = async (month: number, module: 'devis' | 'factures', target_amount: number) => {
        const key = `${module}-${month}`;
        setSaving(key);
        await supabase
            .from('rep_objectives')
            .upsert(
                { rep_name: repName, module, year, month, target_amount, updated_at: new Date().toISOString() },
                { onConflict: 'rep_name,module,year,month' }
            );
        setObjectives(prev => ({ ...prev, [key]: target_amount }));
        setSaving(null);
    };

    // ─── Guard ────────────────────────────────────────────────────────────────

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

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="p-4 md:p-8 max-w-screen-xl mx-auto space-y-6 md:space-y-8">

            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h2 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                        <Settings className="w-5 h-5 text-slate-400" />
                        Paramètres
                    </h2>
                    <p className="text-sm text-slate-400 mt-0.5">
                        Configurez vos objectifs · {repName || 'Représentant'}
                    </p>
                </div>
                <Select
                    value={String(year)}
                    onChange={v => setYear(Number(v))}
                    options={yearOptions}
                    variant="accent"
                    className="w-28"
                />
            </div>

            {/* Objectives section */}
            <div className="space-y-4">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-brand-main/10 flex items-center justify-center shrink-0">
                        <span className="text-brand-main font-bold text-sm">01</span>
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">Objectifs mensuels</h3>
                        <p className="text-xs text-slate-400">Cliquez sur une cellule pour modifier. Sauvegarde automatique.</p>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-16 gap-2">
                        <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
                        <span className="text-sm text-slate-400">Chargement...</span>
                    </div>
                ) : (
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-slate-100 bg-slate-50/60">
                                        <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest sticky left-0 bg-slate-50/60">
                                            Mois
                                        </th>
                                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest">
                                            <div className="flex items-center justify-center gap-1.5 text-blue-400">
                                                <ClipboardList className="w-3 h-3" />
                                                Objectif Devis
                                            </div>
                                        </th>
                                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest">
                                            <div className="flex items-center justify-center gap-1.5 text-amber-500">
                                                <FileText className="w-3 h-3" />
                                                Objectif Factures
                                            </div>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                    {MONTH_LABELS.map((label, i) => {
                                        const month = i + 1;
                                        const devisKey = `devis-${month}`;
                                        const factKey = `factures-${month}`;
                                        return (
                                            <tr key={month} className="hover:bg-slate-50/40 transition-colors">
                                                <td className="px-5 py-2.5 font-semibold text-slate-700 sticky left-0 bg-white whitespace-nowrap">
                                                    {label}
                                                    {saving === devisKey || saving === factKey ? (
                                                        <Loader2 className="w-3 h-3 animate-spin text-slate-300 inline ml-2" />
                                                    ) : null}
                                                </td>
                                                <td className="px-4 py-2">
                                                    <TargetCell
                                                        value={objectives[devisKey] ?? 0}
                                                        onSave={v => saveTarget(month, 'devis', v)}
                                                    />
                                                </td>
                                                <td className="px-4 py-2">
                                                    <TargetCell
                                                        value={objectives[factKey] ?? 0}
                                                        onSave={v => saveTarget(month, 'factures', v)}
                                                    />
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t-2 border-slate-100 bg-slate-50/60">
                                        <td className="px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-widest sticky left-0 bg-slate-50/60">
                                            Total {year}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <span className="text-sm font-bold text-slate-700 tabular-nums">
                                                {(() => {
                                                    const t = MONTH_LABELS.reduce((s, _, i) => s + (objectives[`devis-${i + 1}`] ?? 0), 0);
                                                    return t > 0 ? formatCurrencyCAD(t) : <span className="text-slate-300">—</span>;
                                                })()}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <span className="text-sm font-bold text-slate-700 tabular-nums">
                                                {(() => {
                                                    const t = MONTH_LABELS.reduce((s, _, i) => s + (objectives[`factures-${i + 1}`] ?? 0), 0);
                                                    return t > 0 ? formatCurrencyCAD(t) : <span className="text-slate-300">—</span>;
                                                })()}
                                            </span>
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>
                )}
            </div>

            {/* Coming soon */}
            <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 rounded-xl border border-slate-100 text-xs text-slate-400">
                <Settings className="w-4 h-4 shrink-0" />
                D'autres paramètres seront disponibles prochainement.
            </div>
        </div>
    );
}
