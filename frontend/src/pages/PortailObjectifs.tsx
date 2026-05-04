import { useState, useEffect, useCallback } from 'react';
import { useUrlStateNumber } from '../hooks/useUrlState';
import { Target, Loader2, FileText, User, BarChart2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { DEPARTMENTS } from '../lib/constants';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_LABELS = [
    'Janvier','Février','Mars','Avril','Mai','Juin',
    'Juillet','Août','Septembre','Octobre','Novembre','Décembre',
];
const MONTH_SHORT = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

const DEPT_SHORT: Record<string, string> = {
    'MULTI-ANNONCEURS':        'Multi-Ann.',
    'PROMOTIONNEL':            'Promo',
    'DIST. PUBLICITAIRE SOLO': 'Solo',
    'NUMERIQUE':               'Numérique',
    'APPLICATION':             'Application',
    'SERVICES IA':             'Services IA',
};

const NOW_MONTH = new Date().getMonth() + 1;
const NOW_YEAR  = new Date().getFullYear();

// compact number: 125000 → "125k", 1600 → "1,6k"
function fmtK(v: number): string {
    if (v <= 0) return '';
    if (v >= 1000) {
        const k = v / 1000;
        return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
    }
    return String(Math.round(v));
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MonthRow {
    month: number;
    label: string;
    target: number;
    actual: number;
    prevActual: number;
}

type DeptMonthData = Record<string, Record<number, { target: number; actual: number; prevActual: number }>>;

interface Props { propRepName?: string; }

// ─── Sub-components ───────────────────────────────────────────────────────────

function Progress({ actual, target }: { actual: number; target: number }) {
    if (target <= 0) return <span className="text-slate-300 text-xs">—</span>;
    const pct = Math.round((actual / target) * 100);
    const clamped = Math.min(pct, 100);
    const color = pct >= 100 ? 'bg-emerald-400' : pct >= 70 ? 'bg-amber-400' : 'bg-red-400';
    const textColor = pct >= 100 ? 'text-emerald-600' : pct >= 70 ? 'text-amber-600' : 'text-red-500';
    return (
        <div className="flex items-center gap-2 min-w-[90px]">
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${clamped}%` }} />
            </div>
            <span className={cn('text-xs font-bold tabular-nums w-9 text-right', textColor)}>{pct}%</span>
        </div>
    );
}

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

    const [year, setYear] = useUrlStateNumber('year', NOW_YEAR);
    const [loading, setLoading] = useState(true);
    const [rows, setRows]       = useState<MonthRow[]>([]);
    const [deptData, setDeptData] = useState<DeptMonthData>({});

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const prevYear = year - 1;

    // ─── Fetch ───────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);

        const [objRes, deptObjRes, factRes, factDeptRes, prevFactRes, prevDeptRes] = await Promise.all([
            supabase.from('rep_objectives').select('month, target_amount')
                .eq('rep_name', repName).eq('year', year).eq('module', 'factures'),
            supabase.from('rep_objectives_dept').select('month, department, target_amount')
                .eq('rep_name', repName).eq('year', year).eq('module', 'factures'),
            supabase.rpc('get_inv_sommaire_grand_total', { p_year: year, p_office: null, p_status: null, p_rep: repName }),
            supabase.rpc('get_rep_dept_actuals_factures', { p_rep: repName, p_year: year }),
            // Previous year actuals
            supabase.rpc('get_inv_sommaire_grand_total', { p_year: prevYear, p_office: null, p_status: null, p_rep: repName }),
            supabase.rpc('get_rep_dept_actuals_factures', { p_rep: repName, p_year: prevYear }),
        ]);

        const objMap: Record<number, number> = {};
        for (const o of (objRes.data ?? [])) objMap[o.month] = Number(o.target_amount);

        const dObjMap: Record<string, number> = {};
        for (const o of (deptObjRes.data ?? [])) dObjMap[`${o.month}-${o.department}`] = Number(o.target_amount);

        const factMap: Record<number, number> = {};
        for (const f of (factRes.data ?? [])) factMap[f.month] = Number(f.actual_amount);

        const factActMap: Record<string, number> = {};
        for (const f of (factDeptRes.data ?? [])) factActMap[`${f.month}-${f.department}`] = Number(f.actual_amount);

        const prevFactMap: Record<number, number> = {};
        for (const f of (prevFactRes.data ?? [])) prevFactMap[f.month] = Number(f.actual_amount);

        const prevDeptActMap: Record<string, number> = {};
        for (const f of (prevDeptRes.data ?? [])) prevDeptActMap[`${f.month}-${f.department}`] = Number(f.actual_amount);

        // Monthly rows
        setRows(MONTH_LABELS.map((label, i) => {
            const m = i + 1;
            const deptSum = DEPARTMENTS.reduce((s, d) => s + (dObjMap[`${m}-${d}`] ?? 0), 0);
            const target  = deptSum > 0 ? deptSum : (objMap[m] ?? 0);
            return { month: m, label, target, actual: factMap[m] ?? 0, prevActual: prevFactMap[m] ?? 0 };
        }));

        // Dept × month matrix
        const dd: DeptMonthData = {};
        for (const dept of DEPARTMENTS) {
            dd[dept] = {};
            for (let m = 1; m <= 12; m++) {
                dd[dept][m] = {
                    target:     dObjMap[`${m}-${dept}`] ?? 0,
                    actual:     factActMap[`${m}-${dept}`] ?? 0,
                    prevActual: prevDeptActMap[`${m}-${dept}`] ?? 0,
                };
            }
        }
        setDeptData(dd);
        setLoading(false);
    }, [repName, year, prevYear]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── Derived ──────────────────────────────────────────────────────────────

    const totals = rows.reduce(
        (acc, r) => ({ target: acc.target + r.target, actual: acc.actual + r.actual, prevActual: acc.prevActual + r.prevActual }),
        { target: 0, actual: 0, prevActual: 0 }
    );
    const pct = totals.target > 0 ? Math.round((totals.actual / totals.target) * 100) : 0;
    const { text: motivText, emoji: motivEmoji } = getMotivation(pct);

    const hasDeptData = DEPARTMENTS.some(dept =>
        Object.values(deptData[dept] ?? {}).some(({ target, actual, prevActual }) => target > 0 || actual > 0 || prevActual > 0)
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
                <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full bg-white/5 pointer-events-none" />
                <div className="absolute -bottom-14 -left-8 w-40 h-40 rounded-full bg-white/5 pointer-events-none" />
                <div className="relative flex flex-col gap-5">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div>
                            <div className="flex items-center gap-2 mb-1.5">
                                <Target className="w-4 h-4 text-white/70" />
                                <span className="text-[10px] font-bold uppercase tracking-widest text-white/60">
                                    Mes Objectifs Factures {year}
                                </span>
                            </div>
                            <h1 className="text-2xl md:text-3xl font-bold leading-tight">{repName || 'Représentant'}</h1>
                            <p className="text-white/80 mt-2 text-sm md:text-base flex items-center gap-2 flex-wrap">
                                <span>{motivText}</span>
                                <span className="text-lg">{motivEmoji}</span>
                            </p>
                        </div>
                    </div>
                    {/* KPI */}
                    <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4 md:p-5 flex items-center justify-between gap-6 flex-wrap">
                        <div className="flex items-center gap-3">
                            <FileText className="w-5 h-5 text-white/70 shrink-0" />
                            <div>
                                <p className="text-[10px] font-bold uppercase tracking-widest text-white/60">Total Facturé {year}</p>
                                <p className="text-2xl md:text-3xl font-bold tabular-nums leading-none mt-0.5">
                                    {formatCurrencyCAD(totals.actual)}
                                </p>
                                <p className="text-[11px] text-white/60 mt-1">
                                    {totals.target > 0
                                        ? `sur ${formatCurrencyCAD(totals.target)} objectif`
                                        : 'Objectif non fixé — configurez dans Paramètres'}
                                    {totals.prevActual > 0 && (
                                        <span className="ml-2 opacity-70">· {formatCurrencyCAD(totals.prevActual)} en {prevYear}</span>
                                    )}
                                </p>
                            </div>
                        </div>
                        {totals.target > 0 && (
                            <div className="flex-1 min-w-[160px] max-w-xs">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-sm font-bold text-white">{pct}% atteint</span>
                                </div>
                                <div className="h-2.5 bg-white/20 rounded-full overflow-hidden">
                                    <div
                                        className={cn('h-full rounded-full transition-all duration-700',
                                            pct >= 100 ? 'bg-emerald-300' : pct >= 70 ? 'bg-amber-300' : 'bg-red-400'
                                        )}
                                        style={{ width: `${Math.min(pct, 100)}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Filters ── */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
            </FilterBar>

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
                <>
                    {/* ── Monthly totals table ── */}
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-slate-100 bg-slate-50/60">
                                        <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Mois</th>
                                        <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">{prevYear}</th>
                                        <th className="px-4 py-3 text-right text-[10px] font-bold text-amber-500 uppercase tracking-widest">{year}</th>
                                        <th className="px-4 py-3 text-right text-[10px] font-bold text-amber-500 uppercase tracking-widest border-l border-slate-100">Objectif</th>
                                        <th className="px-4 py-3 text-[10px] font-bold text-amber-400 uppercase tracking-widest min-w-[130px]">Atteinte</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                    {rows.map(row => {
                                        const isCurrent = row.month === NOW_MONTH && year === NOW_YEAR;
                                        return (
                                            <tr key={row.month} className={cn(
                                                'hover:bg-slate-50/60 transition-colors',
                                                isCurrent && 'bg-brand-main/5 hover:bg-brand-main/10'
                                            )}>
                                                <td className="px-5 py-3 font-semibold text-slate-700 whitespace-nowrap">
                                                    <div className="flex items-center gap-2">
                                                        {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-brand-main shrink-0" />}
                                                        {row.label}
                                                        {isCurrent && (
                                                            <span className="text-[9px] font-bold uppercase tracking-wider text-brand-main bg-brand-main/10 px-1.5 py-0.5 rounded-full">En cours</span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-right tabular-nums text-slate-400">
                                                    {row.prevActual > 0 ? (
                                                        <span className="text-xs font-medium">{formatCurrencyCAD(row.prevActual)}</span>
                                                    ) : (
                                                        <span className="text-slate-200">—</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-right font-semibold tabular-nums text-amber-700">
                                                    {row.actual > 0 ? formatCurrencyCAD(row.actual) : <span className="text-slate-200">—</span>}
                                                </td>
                                                <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-700 border-l border-slate-100">
                                                    {row.target > 0 ? formatCurrencyCAD(row.target) : <span className="text-slate-200">—</span>}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <Progress actual={row.actual} target={row.target} />
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t-2 border-slate-200 bg-slate-50/80">
                                        <td className="px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-widest">Total {year}</td>
                                        <td className="px-4 py-3 text-right tabular-nums">
                                            {totals.prevActual > 0 ? (
                                                <span className="text-sm font-semibold text-slate-500">{formatCurrencyCAD(totals.prevActual)}</span>
                                            ) : (
                                                <span className="text-slate-300">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-right font-bold text-amber-700 tabular-nums">
                                            {totals.actual > 0 ? formatCurrencyCAD(totals.actual) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-right font-bold text-slate-800 tabular-nums border-l border-slate-100">
                                            {totals.target > 0 ? formatCurrencyCAD(totals.target) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-4 py-3"><Progress actual={totals.actual} target={totals.target} /></td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>

                    {/* ── Department cards ── */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-3">
                            <div className="w-7 h-7 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                                <BarChart2 className="w-3.5 h-3.5 text-slate-400" />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-slate-800">Répartition par département</h3>
                                <p className="text-xs text-slate-400">
                                    <span className="text-slate-400 font-medium">{prevYear}</span>
                                    {' · '}<span className="text-amber-500 font-medium">{year}</span>
                                    {' · '}Objectif
                                </p>
                            </div>
                        </div>

                        {!hasDeptData ? (
                            <div className="bg-white rounded-2xl border border-slate-100 px-6 py-10 flex flex-col items-center gap-2 text-center">
                                <BarChart2 className="w-8 h-8 text-slate-200" />
                                <p className="text-sm font-medium text-slate-400">Aucun objectif par département configuré</p>
                                <p className="text-xs text-slate-300">Rendez-vous dans Paramètres pour définir vos objectifs par département.</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {DEPARTMENTS.map(dept => {
                                    const monthCells = deptData[dept] ?? {};
                                    const hasRow = Object.values(monthCells).some(c => c.target > 0 || c.actual > 0 || c.prevActual > 0);
                                    if (!hasRow) return null;

                                    const rowTotal = Object.values(monthCells).reduce(
                                        (acc, c) => ({ target: acc.target + c.target, actual: acc.actual + c.actual, prevActual: acc.prevActual + c.prevActual }),
                                        { target: 0, actual: 0, prevActual: 0 }
                                    );
                                    const pct = rowTotal.target > 0 ? Math.round((rowTotal.actual / rowTotal.target) * 100) : null;
                                    const pctColor = pct === null ? '' : pct >= 100 ? 'text-emerald-600' : pct >= 70 ? 'text-amber-600' : 'text-red-500';
                                    const barColor = pct === null ? '' : pct >= 100 ? 'bg-emerald-400' : pct >= 70 ? 'bg-amber-400' : 'bg-red-400';

                                    return (
                                        <div key={dept} className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">

                                            {/* Card header */}
                                            <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/50">
                                                <span className="text-sm font-bold text-slate-800">{dept}</span>
                                                <div className="flex items-start gap-0 mt-2 divide-x divide-slate-200">
                                                    <div className="pr-4">
                                                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{year}</p>
                                                        <p className="text-sm font-bold text-amber-700 tabular-nums leading-tight">{formatCurrencyCAD(rowTotal.actual)}</p>
                                                    </div>
                                                    {rowTotal.target > 0 && (
                                                        <div className="px-4">
                                                            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Objectif</p>
                                                            <p className="text-sm font-semibold text-slate-600 tabular-nums leading-tight">{formatCurrencyCAD(rowTotal.target)}</p>
                                                        </div>
                                                    )}
                                                    {pct !== null && (
                                                        <div className="pl-4">
                                                            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Atteinte</p>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <div className="w-20 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                                                    <div className={cn('h-full rounded-full', barColor)} style={{ width: `${Math.min(pct, 100)}%` }} />
                                                                </div>
                                                                <span className={cn('text-sm font-bold tabular-nums', pctColor)}>{pct}%</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Month table — one clean row per metric */}
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-xs">
                                                    <thead>
                                                        <tr className="border-b border-slate-100">
                                                            <th className="px-4 py-2 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest w-20 shrink-0" />
                                                            {MONTH_SHORT.map((m, i) => (
                                                                <th key={i} className={cn(
                                                                    'px-3 py-2 text-center text-[10px] font-bold uppercase tracking-widest min-w-[52px]',
                                                                    (i + 1) === NOW_MONTH && year === NOW_YEAR
                                                                        ? 'text-brand-main' : 'text-slate-400'
                                                                )}>
                                                                    {m}
                                                                </th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {/* current year row */}
                                                        <tr className="border-b border-slate-50 hover:bg-slate-50/40 transition-colors">
                                                            <td className="px-4 py-2.5 text-[10px] font-bold text-amber-500 uppercase tracking-widest whitespace-nowrap">{year}</td>
                                                            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                                                                const cell = monthCells[m] ?? { target: 0, actual: 0, prevActual: 0 };
                                                                const isCurrent = m === NOW_MONTH && year === NOW_YEAR;
                                                                const cellColor = cell.target > 0
                                                                    ? (cell.actual >= cell.target ? 'text-emerald-500' : cell.actual >= cell.target * 0.7 ? 'text-amber-500' : 'text-red-400')
                                                                    : 'text-amber-600';
                                                                return (
                                                                    <td key={m} className={cn(
                                                                        'px-3 py-2.5 text-center tabular-nums font-bold',
                                                                        cellColor,
                                                                        isCurrent && 'bg-brand-main/5'
                                                                    )}>
                                                                        {cell.actual > 0 ? fmtK(cell.actual) : <span className="text-slate-150 font-normal">—</span>}
                                                                    </td>
                                                                );
                                                            })}
                                                        </tr>
                                                        {/* objective row */}
                                                        <tr className="hover:bg-slate-50/40 transition-colors">
                                                            <td className="px-4 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">Objectif</td>
                                                            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                                                                const cell = monthCells[m] ?? { target: 0, actual: 0, prevActual: 0 };
                                                                return (
                                                                    <td key={m} className="px-3 py-2.5 text-center tabular-nums text-slate-500 font-semibold">
                                                                        {cell.target > 0 ? fmtK(cell.target) : <span className="text-slate-150 font-normal">—</span>}
                                                                    </td>
                                                                );
                                                            })}
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
