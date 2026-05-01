import { useState, useEffect, useCallback } from 'react';
import { Target, Loader2, ClipboardList, FileText, User } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MONTHS } from '../lib/constants';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepObjective {
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

interface Props { propRepName?: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_LABELS = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

const NOW_MONTH = new Date().getMonth() + 1;
const NOW_YEAR = new Date().getFullYear();

// ─── Progress bar ─────────────────────────────────────────────────────────────

function Progress({ actual, target }: { actual: number; target: number }) {
    if (target <= 0) return <span className="text-slate-300 text-xs">—</span>;
    const pct = Math.round((actual / target) * 100);
    const clamped = Math.min(pct, 100);
    const color = pct >= 100 ? 'bg-emerald-400' : pct >= 70 ? 'bg-amber-400' : 'bg-red-400';
    const textColor = pct >= 100 ? 'text-emerald-600' : pct >= 70 ? 'text-amber-600' : 'text-red-500';
    return (
        <div className="flex items-center gap-2 min-w-[100px]">
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${clamped}%` }} />
            </div>
            <span className={cn('text-xs font-bold tabular-nums w-9 text-right', textColor)}>{pct}%</span>
        </div>
    );
}

// ─── Hero KPI card ─────────────────────────────────────────────────────────────

function HeroKpiCard({
    icon: Icon,
    label,
    actual,
    target,
}: {
    icon: React.ElementType;
    label: string;
    actual: number;
    target: number;
}) {
    const pct = target > 0 ? Math.round((actual / target) * 100) : 0;
    const clamped = Math.min(pct, 100);
    const barColor = pct >= 100 ? 'bg-emerald-300' : pct >= 70 ? 'bg-amber-300' : 'bg-red-300';

    return (
        <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4 md:p-5 flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-3">
                <Icon className="w-3.5 h-3.5 text-white/70 shrink-0" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/70">{label}</span>
            </div>
            <p className="text-xl md:text-2xl font-bold tabular-nums leading-none truncate">
                {formatCurrencyCAD(actual)}
            </p>
            <p className="text-[11px] text-white/60 mt-1">
                {target > 0 ? `sur ${formatCurrencyCAD(target)}` : 'Objectif non fixé — configurez dans Paramètres'}
            </p>
            {target > 0 && (
                <div className="mt-3">
                    <div className="flex justify-between items-center mb-1.5">
                        <span className="text-xs font-bold text-white">{pct}% atteint</span>
                    </div>
                    <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                        <div
                            className={cn('h-full rounded-full transition-all duration-700', barColor)}
                            style={{ width: `${clamped}%` }}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Motivational text ────────────────────────────────────────────────────────

function getMotivation(pct: number): { text: string; emoji: string } {
    if (pct >= 100) return { text: 'Objectif atteint! Tu es une légende!', emoji: '🏆' };
    if (pct >= 75)  return { text: 'Presque là, donne tout!',              emoji: '🚀' };
    if (pct >= 50)  return { text: 'À mi-chemin, continue!',               emoji: '🎯' };
    return                  { text: "T'es une machine, lâche pas!",         emoji: '💪' };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortailObjectifs({ propRepName }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const [year, setYear] = useState(NOW_YEAR);
    const [selectedMonth, setSelectedMonth] = useState<number | 'Tous'>('Tous');
    const [loading, setLoading] = useState(true);
    const [rows, setRows] = useState<MonthRow[]>([]);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = [
        { value: 'Tous', label: 'Tous les mois' },
        ...MONTHS.map(m => ({ value: String(m.value), label: m.label })),
    ];

    // ─── Fetch ───────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);

        const [objRes, devisRes, factRes] = await Promise.all([
            supabase.from('rep_objectives').select('*').eq('rep_name', repName).eq('year', year),
            supabase.rpc('get_sommaire_grand_total', { p_year: year, p_office: null, p_status: null, p_rep: repName }),
            supabase.rpc('get_inv_sommaire_grand_total', { p_year: year, p_office: null, p_status: null, p_rep: repName }),
        ]);

        const objectives  = (objRes.data   ?? []) as RepObjective[];
        const devisActuals = (devisRes.data ?? []) as { month: number; actual_amount: number }[];
        const factActuals  = (factRes.data  ?? []) as { month: number; actual_amount: number }[];

        const objMap: Record<string, number> = {};
        for (const o of objectives) { objMap[`${o.module}-${o.month}`] = o.target_amount; }

        const devisMap: Record<number, number> = {};
        for (const d of devisActuals) { devisMap[d.month] = d.actual_amount; }

        const factMap: Record<number, number> = {};
        for (const f of factActuals) { factMap[f.month] = f.actual_amount; }

        setRows(MONTH_LABELS.map((label, i) => ({
            month: i + 1,
            label,
            devisTarget:    objMap[`devis-${i + 1}`]    ?? 0,
            devisActual:    devisMap[i + 1]              ?? 0,
            facturesTarget: objMap[`factures-${i + 1}`] ?? 0,
            facturesActual: factMap[i + 1]               ?? 0,
        })));

        setLoading(false);
    }, [repName, year]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── Derived ──────────────────────────────────────────────────────────────

    const totals = rows.reduce(
        (acc, r) => ({
            devisTarget:    acc.devisTarget    + r.devisTarget,
            devisActual:    acc.devisActual    + r.devisActual,
            facturesTarget: acc.facturesTarget + r.facturesTarget,
            facturesActual: acc.facturesActual + r.facturesActual,
        }),
        { devisTarget: 0, devisActual: 0, facturesTarget: 0, facturesActual: 0 }
    );

    const devisPct = totals.devisTarget > 0 ? Math.round((totals.devisActual / totals.devisTarget) * 100) : 0;
    const { text: motivText, emoji: motivEmoji } = getMotivation(devisPct);

    const displayedRows = selectedMonth === 'Tous'
        ? rows
        : rows.filter(r => r.month === selectedMonth);

    const displayedTotals = displayedRows.reduce(
        (acc, r) => ({
            devisTarget:    acc.devisTarget    + r.devisTarget,
            devisActual:    acc.devisActual    + r.devisActual,
            facturesTarget: acc.facturesTarget + r.facturesTarget,
            facturesActual: acc.facturesActual + r.facturesActual,
        }),
        { devisTarget: 0, devisActual: 0, facturesTarget: 0, facturesActual: 0 }
    );

    // ─── Guard ────────────────────────────────────────────────────────────────

    if (!repName && !isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-xl mx-auto flex items-center justify-center min-h-[60vh]">
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto">
                        <User className="w-7 h-7 text-slate-300" />
                    </div>
                    <h2 className="text-base font-semibold text-slate-700">Portail non configuré</h2>
                    <p className="text-sm text-slate-400 max-w-xs">Votre compte n'est pas encore associé à un représentant. Contactez un administrateur.</p>
                </div>
            </div>
        );
    }

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="p-4 md:p-8 max-w-screen-xl mx-auto space-y-5 md:space-y-6">

            {/* ── Hero banner ── */}
            <div className="relative overflow-hidden bg-gradient-to-br from-brand-main via-brand-main/90 to-amber-500 rounded-2xl p-6 md:p-8 text-white shadow-lg shadow-brand-main/20">
                {/* Decorative blobs */}
                <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full bg-white/5 pointer-events-none" />
                <div className="absolute -bottom-14 -left-8 w-40 h-40 rounded-full bg-white/5 pointer-events-none" />

                <div className="relative flex flex-col gap-6">
                    {/* Greeting row */}
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div>
                            <div className="flex items-center gap-2 mb-1.5">
                                <Target className="w-4 h-4 text-white/70" />
                                <span className="text-[10px] font-bold uppercase tracking-widest text-white/60">
                                    Mes Objectifs {year}
                                </span>
                            </div>
                            <h1 className="text-2xl md:text-3xl font-bold leading-tight">{repName || 'Représentant'}</h1>
                            <p className="text-white/80 mt-2 text-sm md:text-base flex items-center gap-2 flex-wrap">
                                <span>{motivText}</span>
                                <span className="text-lg">{motivEmoji}</span>
                            </p>
                        </div>
                    </div>

                    {/* KPI cards */}
                    <div className="flex gap-3 md:gap-4">
                        <HeroKpiCard
                            icon={ClipboardList}
                            label="Devis"
                            actual={totals.devisActual}
                            target={totals.devisTarget}
                        />
                        <HeroKpiCard
                            icon={FileText}
                            label="Factures"
                            actual={totals.facturesActual}
                            target={totals.facturesTarget}
                        />
                    </div>
                </div>
            </div>

            {/* ── Filters ── */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select
                        value={String(year)}
                        onChange={v => setYear(Number(v))}
                        options={yearOptions}
                        variant="accent"
                        className="w-28"
                    />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={selectedMonth === 'Tous' ? 'Tous' : String(selectedMonth)}
                        onChange={v => setSelectedMonth(v === 'Tous' ? 'Tous' : Number(v))}
                        options={monthOptions}
                        className="w-40"
                    />
                </FilterGroup>
            </FilterBar>

            {/* ── Table ── */}
            {!repName ? (
                <div className="flex flex-col items-center justify-center py-20 gap-2">
                    <Target className="w-8 h-8 text-slate-200" />
                    <p className="text-sm text-slate-400">Sélectionnez un représentant</p>
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
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-blue-400 uppercase tracking-widest">Objectif Devis</th>
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-blue-400 uppercase tracking-widest">Réalisé</th>
                                    <th className="px-4 py-3 text-[10px] font-bold text-blue-300 uppercase tracking-widest min-w-[120px]">Atteinte</th>
                                    <th className="w-px bg-slate-100" />
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-amber-500 uppercase tracking-widest">Objectif Factures</th>
                                    <th className="px-4 py-3 text-right text-[10px] font-bold text-amber-500 uppercase tracking-widest">Réalisé</th>
                                    <th className="px-4 py-3 text-[10px] font-bold text-amber-400 uppercase tracking-widest min-w-[120px]">Atteinte</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {displayedRows.map(row => {
                                    const isCurrent = row.month === NOW_MONTH && year === NOW_YEAR;
                                    return (
                                        <tr
                                            key={row.month}
                                            className={cn(
                                                'hover:bg-slate-50/60 transition-colors',
                                                isCurrent && 'bg-brand-main/5 hover:bg-brand-main/10'
                                            )}
                                        >
                                            <td className="px-5 py-3 font-semibold text-slate-700 whitespace-nowrap">
                                                <div className="flex items-center gap-2">
                                                    {isCurrent && (
                                                        <span className="w-1.5 h-1.5 rounded-full bg-brand-main shrink-0" />
                                                    )}
                                                    {row.label}
                                                    {isCurrent && (
                                                        <span className="text-[9px] font-bold uppercase tracking-wider text-brand-main bg-brand-main/10 px-1.5 py-0.5 rounded-full">
                                                            En cours
                                                        </span>
                                                    )}
                                                </div>
                                            </td>

                                            {/* Devis */}
                                            <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-700">
                                                {row.devisTarget > 0 ? formatCurrencyCAD(row.devisTarget) : <span className="text-slate-200">—</span>}
                                            </td>
                                            <td className="px-4 py-3 text-right font-semibold text-blue-700 tabular-nums">
                                                {row.devisActual > 0 ? formatCurrencyCAD(row.devisActual) : <span className="text-slate-200">—</span>}
                                            </td>
                                            <td className="px-4 py-3">
                                                <Progress actual={row.devisActual} target={row.devisTarget} />
                                            </td>

                                            <td className="w-px bg-slate-100 p-0" />

                                            {/* Factures */}
                                            <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-700">
                                                {row.facturesTarget > 0 ? formatCurrencyCAD(row.facturesTarget) : <span className="text-slate-200">—</span>}
                                            </td>
                                            <td className="px-4 py-3 text-right font-semibold text-amber-700 tabular-nums">
                                                {row.facturesActual > 0 ? formatCurrencyCAD(row.facturesActual) : <span className="text-slate-200">—</span>}
                                            </td>
                                            <td className="px-4 py-3">
                                                <Progress actual={row.facturesActual} target={row.facturesTarget} />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            <tfoot>
                                <tr className="border-t-2 border-slate-200 bg-slate-50/80">
                                    <td className="px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-widest">
                                        {selectedMonth === 'Tous'
                                            ? `Total ${year}`
                                            : MONTH_LABELS[(selectedMonth as number) - 1]}
                                    </td>
                                    <td className="px-4 py-3 text-right font-bold text-slate-800 tabular-nums">
                                        {displayedTotals.devisTarget > 0 ? formatCurrencyCAD(displayedTotals.devisTarget) : <span className="text-slate-300">—</span>}
                                    </td>
                                    <td className="px-4 py-3 text-right font-bold text-blue-700 tabular-nums">
                                        {displayedTotals.devisActual > 0 ? formatCurrencyCAD(displayedTotals.devisActual) : <span className="text-slate-300">—</span>}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Progress actual={displayedTotals.devisActual} target={displayedTotals.devisTarget} />
                                    </td>
                                    <td className="w-px bg-slate-200 p-0" />
                                    <td className="px-4 py-3 text-right font-bold text-slate-800 tabular-nums">
                                        {displayedTotals.facturesTarget > 0 ? formatCurrencyCAD(displayedTotals.facturesTarget) : <span className="text-slate-300">—</span>}
                                    </td>
                                    <td className="px-4 py-3 text-right font-bold text-amber-700 tabular-nums">
                                        {displayedTotals.facturesActual > 0 ? formatCurrencyCAD(displayedTotals.facturesActual) : <span className="text-slate-300">—</span>}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Progress actual={displayedTotals.facturesActual} target={displayedTotals.facturesTarget} />
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
