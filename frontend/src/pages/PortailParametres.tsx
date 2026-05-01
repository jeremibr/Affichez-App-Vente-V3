import { useState, useEffect, useCallback } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import {
    Settings, Loader2, Check, X, Save, User, ClipboardList, FileText,
    Wand2, ChevronRight,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { Select } from '../components/Select';
import { DEPARTMENTS, MONTHS } from '../lib/constants';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepObjective {
    rep_name: string;
    module: 'devis' | 'factures';
    year: number;
    month: number;
    target_amount: number;
}

interface RepObjectiveDept {
    rep_name: string;
    module: 'devis' | 'factures';
    year: number;
    month: number;
    department: string;
    target_amount: number;
}

interface Props { propRepName?: string; }

const MONTH_LABELS = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

const DEPT_SHORT: Record<string, string> = {
    'MULTI-ANNONCEURS':        'Multi',
    'PROMOTIONNEL':            'Promo',
    'DIST. PUBLICITAIRE SOLO': 'Solo',
    'NUMERIQUE':               'Num.',
    'APPLICATION':             'App.',
    'SERVICES IA':             'IA',
};

// ─── Inline target cell ───────────────────────────────────────────────────────

function TargetCell({ value, onSave, compact }: { value: number; onSave: (v: number) => void; compact?: boolean }) {
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
                    className={cn(
                        'px-2 py-1.5 text-sm border border-brand-main rounded-lg focus:outline-none text-right font-semibold bg-white',
                        compact ? 'w-24' : 'w-28'
                    )}
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
                'w-full flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-lg text-sm font-semibold transition-all group',
                value > 0
                    ? 'bg-slate-50 hover:bg-brand-main/5 hover:text-brand-main text-slate-700'
                    : 'bg-slate-50 hover:bg-brand-main/5 text-slate-300 hover:text-brand-main'
            )}
        >
            <Save className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-brand-main shrink-0" />
            <span className={cn('flex-1 text-right tabular-nums', compact ? 'text-xs' : 'text-sm')}>
                {value > 0 ? formatCurrencyCAD(value) : '—'}
            </span>
        </button>
    );
}

// ─── Section 01 — Monthly totals ──────────────────────────────────────────────

function MonthlyObjectivesSection({
    repName, year,
}: { repName: string; year: number }) {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [objectives, setObjectives] = useState<Record<string, number>>({});

    const fetch = useCallback(async () => {
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

    useEffect(() => { fetch(); }, [fetch]);

    const save = async (month: number, module: 'devis' | 'factures', target_amount: number) => {
        const key = `${module}-${month}`;
        setSaving(key);
        await supabase.from('rep_objectives').upsert(
            { rep_name: repName, module, year, month, target_amount, updated_at: new Date().toISOString() },
            { onConflict: 'rep_name,module,year,month' }
        );
        setObjectives(prev => ({ ...prev, [key]: target_amount }));
        setSaving(null);
    };

    if (loading) return (
        <div className="flex items-center justify-center py-12 gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
            <span className="text-sm text-slate-400">Chargement...</span>
        </div>
    );

    return (
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
                                    <ClipboardList className="w-3 h-3" />Objectif Devis
                                </div>
                            </th>
                            <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest">
                                <div className="flex items-center justify-center gap-1.5 text-amber-500">
                                    <FileText className="w-3 h-3" />Objectif Factures
                                </div>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {MONTH_LABELS.map((label, i) => {
                            const month = i + 1;
                            const dk = `devis-${month}`;
                            const fk = `factures-${month}`;
                            return (
                                <tr key={month} className="hover:bg-slate-50/40 transition-colors">
                                    <td className="px-5 py-2.5 font-semibold text-slate-700 sticky left-0 bg-white whitespace-nowrap">
                                        {label}
                                        {(saving === dk || saving === fk) && (
                                            <Loader2 className="w-3 h-3 animate-spin text-slate-300 inline ml-2" />
                                        )}
                                    </td>
                                    <td className="px-4 py-2">
                                        <TargetCell value={objectives[dk] ?? 0} onSave={v => save(month, 'devis', v)} />
                                    </td>
                                    <td className="px-4 py-2">
                                        <TargetCell value={objectives[fk] ?? 0} onSave={v => save(month, 'factures', v)} />
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
    );
}

// ─── Section 02 — Department objectives ──────────────────────────────────────

function DeptObjectivesSection({
    repName, year,
}: { repName: string; year: number }) {
    const [deptModule, setDeptModule] = useUrlState('dept_module', 'devis');
    const module = deptModule as 'devis' | 'factures';

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [objectives, setObjectives] = useState<Record<string, number>>({});

    // Quick-fill state
    const [annualInput, setAnnualInput] = useState('');
    const [splitMonths, setSplitMonths] = useState(true);
    const [splitDepts, setSplitDepts] = useState(true);
    const [applying, setApplying] = useState(false);

    const deptKey = (month: number, dept: string) => `${month}-${dept}`;

    const fetch = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);
        const { data } = await supabase
            .from('rep_objectives_dept')
            .select('month, department, target_amount')
            .eq('rep_name', repName)
            .eq('module', module)
            .eq('year', year);
        const map: Record<string, number> = {};
        for (const o of (data ?? []) as RepObjectiveDept[]) {
            map[deptKey(o.month, o.department)] = o.target_amount;
        }
        setObjectives(map);
        setLoading(false);
    }, [repName, module, year]);

    useEffect(() => { fetch(); }, [fetch]);

    const save = async (month: number, department: string, target_amount: number) => {
        const key = deptKey(month, department);
        setSaving(key);
        await supabase.from('rep_objectives_dept').upsert(
            { rep_name: repName, module, year, month, department, target_amount, updated_at: new Date().toISOString() },
            { onConflict: 'rep_name,module,year,month,department' }
        );
        setObjectives(prev => ({ ...prev, [key]: target_amount }));
        setSaving(null);
    };

    const applyQuickFill = async () => {
        const total = parseFloat(annualInput.replace(/[^0-9.]/g, '')) || 0;
        if (total <= 0) return;

        const numMonths = splitMonths ? 12 : 1;
        const numDepts = splitDepts ? DEPARTMENTS.length : 1;
        const perCell = Math.round((total / numMonths / numDepts) * 100) / 100;

        setApplying(true);

        const rows: RepObjectiveDept[] = [];
        const newMap: Record<string, number> = { ...objectives };

        if (splitMonths && splitDepts) {
            // Fill every cell equally
            for (let m = 1; m <= 12; m++) {
                for (const dept of DEPARTMENTS) {
                    rows.push({ rep_name: repName, module, year, month: m, department: dept, target_amount: perCell });
                    newMap[deptKey(m, dept)] = perCell;
                }
            }
        } else if (splitMonths && !splitDepts) {
            // Not splitting depts: set total per month = total/12, leave dept cells unchanged
            // This doesn't quite make sense for dept table — skip
        } else if (!splitMonths && splitDepts) {
            // User wants to split total across depts but not months — apply as annual target per dept
            // Spread equally across depts only (no month distribution)
        }

        if (rows.length > 0) {
            await supabase.from('rep_objectives_dept').upsert(
                rows.map(r => ({ ...r, updated_at: new Date().toISOString() })),
                { onConflict: 'rep_name,module,year,month,department' }
            );
            setObjectives(newMap);
        }

        setApplying(false);
        setAnnualInput('');
    };

    const monthTotal = (month: number) =>
        DEPARTMENTS.reduce((s, d) => s + (objectives[deptKey(month, d)] ?? 0), 0);

    const deptTotal = (dept: string) =>
        MONTHS.reduce((s, m) => s + (objectives[deptKey(m.value, dept)] ?? 0), 0);

    const grandTotal = MONTHS.reduce((s, m) => s + monthTotal(m.value), 0);

    return (
        <div className="space-y-4">
            {/* Module tabs */}
            <div className="flex items-center gap-2">
                {(['devis', 'factures'] as const).map(m => (
                    <button
                        key={m}
                        onClick={() => setDeptModule(m)}
                        className={cn(
                            'flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all',
                            module === m
                                ? m === 'devis'
                                    ? 'bg-blue-50 text-blue-600 border border-blue-200'
                                    : 'bg-amber-50 text-amber-600 border border-amber-200'
                                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                        )}
                    >
                        {m === 'devis'
                            ? <ClipboardList className="w-3.5 h-3.5" />
                            : <FileText className="w-3.5 h-3.5" />}
                        {m === 'devis' ? 'Devis' : 'Factures'}
                    </button>
                ))}
            </div>

            {/* Quick-fill card */}
            <div className="bg-gradient-to-br from-slate-50 to-white rounded-2xl border border-slate-100 p-5">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-7 h-7 rounded-lg bg-brand-main/10 flex items-center justify-center shrink-0">
                        <Wand2 className="w-3.5 h-3.5 text-brand-main" />
                    </div>
                    <div>
                        <p className="text-sm font-bold text-slate-800">Remplissage automatique</p>
                        <p className="text-xs text-slate-400">Entrez un objectif annuel et choisissez comment le répartir</p>
                    </div>
                </div>

                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex-1 min-w-[180px]">
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                            Objectif annuel total
                        </label>
                        <input
                            type="text"
                            value={annualInput}
                            onChange={e => setAnnualInput(e.target.value)}
                            placeholder="ex: 500000"
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-brand-main font-semibold tabular-nums"
                        />
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-2.5 cursor-pointer group">
                            <div
                                onClick={() => setSplitMonths(v => !v)}
                                className={cn(
                                    'w-4 h-4 rounded border-2 flex items-center justify-center transition-all cursor-pointer',
                                    splitMonths ? 'bg-brand-main border-brand-main' : 'border-slate-300 bg-white'
                                )}
                            >
                                {splitMonths && <Check className="w-2.5 h-2.5 text-white" />}
                            </div>
                            <span className="text-xs font-medium text-slate-700">Répartir sur 12 mois</span>
                        </label>
                        <label className="flex items-center gap-2.5 cursor-pointer group">
                            <div
                                onClick={() => setSplitDepts(v => !v)}
                                className={cn(
                                    'w-4 h-4 rounded border-2 flex items-center justify-center transition-all cursor-pointer',
                                    splitDepts ? 'bg-brand-main border-brand-main' : 'border-slate-300 bg-white'
                                )}
                            >
                                {splitDepts && <Check className="w-2.5 h-2.5 text-white" />}
                            </div>
                            <span className="text-xs font-medium text-slate-700">Répartir entre les {DEPARTMENTS.length} départements</span>
                        </label>
                    </div>

                    <div>
                        {annualInput && splitMonths && splitDepts && (
                            <p className="text-[10px] text-slate-400 mb-1.5 tabular-nums">
                                = {formatCurrencyCAD(Math.round(parseFloat(annualInput.replace(/[^0-9.]/g, '')) / 12 / DEPARTMENTS.length * 100) / 100)} / cellule
                            </p>
                        )}
                        <button
                            onClick={applyQuickFill}
                            disabled={applying || !annualInput || !splitMonths || !splitDepts}
                            className="flex items-center gap-2 bg-brand-main text-white px-4 py-2 rounded-xl text-sm font-semibold shadow-sm hover:bg-brand-main/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                            Appliquer
                        </button>
                    </div>
                </div>

                <p className="text-[10px] text-slate-300 mt-3">
                    La modification manuelle de chaque cellule reste disponible dans le tableau ci-dessous.
                </p>
            </div>

            {/* Department grid */}
            {loading ? (
                <div className="flex items-center justify-center py-12 gap-2">
                    <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
                    <span className="text-sm text-slate-400">Chargement...</span>
                </div>
            ) : (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-100 bg-slate-50/60">
                                    <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest sticky left-0 bg-slate-50/60 whitespace-nowrap">
                                        Mois
                                    </th>
                                    {DEPARTMENTS.map(d => (
                                        <th key={d} className="px-2 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 whitespace-nowrap min-w-[110px]">
                                            <span title={d}>{DEPT_SHORT[d] ?? d}</span>
                                        </th>
                                    ))}
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                        Total mois
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {MONTH_LABELS.map((label, i) => {
                                    const month = i + 1;
                                    const mTotal = monthTotal(month);
                                    return (
                                        <tr key={month} className="hover:bg-slate-50/40 transition-colors">
                                            <td className="px-4 py-2 font-semibold text-slate-700 sticky left-0 bg-white whitespace-nowrap text-sm">
                                                {label}
                                            </td>
                                            {DEPARTMENTS.map(dept => {
                                                const key = deptKey(month, dept);
                                                return (
                                                    <td key={dept} className="px-2 py-1.5">
                                                        {saving === key ? (
                                                            <div className="flex items-center justify-center h-8">
                                                                <Loader2 className="w-3 h-3 animate-spin text-slate-300" />
                                                            </div>
                                                        ) : (
                                                            <TargetCell
                                                                value={objectives[key] ?? 0}
                                                                onSave={v => save(month, dept, v)}
                                                                compact
                                                            />
                                                        )}
                                                    </td>
                                                );
                                            })}
                                            <td className="px-4 py-2 text-right font-bold tabular-nums text-sm text-slate-700 whitespace-nowrap">
                                                {mTotal > 0 ? formatCurrencyCAD(mTotal) : <span className="text-slate-200">—</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            <tfoot>
                                <tr className="border-t-2 border-slate-100 bg-slate-50/60">
                                    <td className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-widest sticky left-0 bg-slate-50/60">
                                        Total {year}
                                    </td>
                                    {DEPARTMENTS.map(dept => {
                                        const t = deptTotal(dept);
                                        return (
                                            <td key={dept} className="px-2 py-3 text-center">
                                                <span className="text-xs font-bold text-slate-700 tabular-nums">
                                                    {t > 0 ? formatCurrencyCAD(t) : <span className="text-slate-200">—</span>}
                                                </span>
                                            </td>
                                        );
                                    })}
                                    <td className="px-4 py-3 text-right">
                                        <span className="text-sm font-bold text-slate-800 tabular-nums">
                                            {grandTotal > 0 ? formatCurrencyCAD(grandTotal) : <span className="text-slate-200">—</span>}
                                        </span>
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortailParametres({ propRepName }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const [year, setYear] = useUrlStateNumber('year', new Date().getFullYear());

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    // ─── Guard ────────────────────────────────────────────────────────────────

    if (!repName && !isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-xl mx-auto flex items-center justify-center min-h-[60vh]">
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
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-8">

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

            {/* ── Section 01: Monthly totals ── */}
            <div className="space-y-4">
                <SectionHeader
                    num="01"
                    title="Objectifs mensuels totaux"
                    sub="Cliquez sur une cellule pour modifier. Sauvegarde automatique."
                />
                <MonthlyObjectivesSection repName={repName} year={year} />
            </div>

            {/* ── Section 02: Department objectives ── */}
            <div className="space-y-4">
                <SectionHeader
                    num="02"
                    title="Objectifs par département"
                    sub="Définissez vos cibles par département et par mois. La somme des départements constitue votre objectif mensuel total."
                />
                {repName
                    ? <DeptObjectivesSection repName={repName} year={year} />
                    : (
                        <div className="flex items-center justify-center py-16 bg-white rounded-2xl border border-slate-100">
                            <p className="text-sm text-slate-400">Représentant non sélectionné</p>
                        </div>
                    )
                }
            </div>

            {/* Coming soon */}
            <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 rounded-xl border border-slate-100 text-xs text-slate-400">
                <Settings className="w-4 h-4 shrink-0" />
                D'autres paramètres seront disponibles prochainement.
            </div>
        </div>
    );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ num, title, sub }: { num: string; title: string; sub: string }) {
    return (
        <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-brand-main/10 flex items-center justify-center shrink-0">
                <span className="text-brand-main font-bold text-sm">{num}</span>
            </div>
            <div>
                <h3 className="text-sm font-bold text-slate-800">{title}</h3>
                <p className="text-xs text-slate-400">{sub}</p>
            </div>
        </div>
    );
}
