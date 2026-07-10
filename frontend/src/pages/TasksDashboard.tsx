import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import {
    Loader2, FilePlus2, CheckCircle2, Percent, Activity, Inbox, AlertTriangle,
    TrendingUp, TrendingDown, Minus, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type {
    TaskKPIs, TasksByRepRow, TasksByStatusRow, TasksWeeklyRow, TasksWoWRow, TasksAvailableWeek,
} from '../types/database';
import { MONTHS, TASK_STATUSES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { SortIcon } from '../components/SortIcon';
import { cn } from '../lib/utils';
import { useSort } from '../hooks/useSort';
import { useRepList } from '../hooks/useRepList';

const STATUS_LABELS: Record<string, string> = Object.fromEntries(TASK_STATUSES.map(s => [s.value, s.label]));

const STATUS_COLORS: Record<string, string> = {
    'Non commencé': 'bg-slate-100 text-slate-500',
    'En cours':     'bg-blue-50 text-blue-600',
    'Achevé':       'bg-emerald-50 text-emerald-600',
    'Non défini':   'bg-slate-100 text-slate-400',
};

const STATUS_BAR: Record<string, string> = {
    'Non commencé': 'bg-slate-300',
    'En cours':     'bg-blue-400',
    'Achevé':       'bg-emerald-400',
    'Non défini':   'bg-slate-200',
};

function pctText(pct: number): string {
    if (pct >= 90) return 'text-emerald-500';
    if (pct >= 50) return 'text-amber-500';
    return 'text-slate-400';
}
function pctBar(pct: number): string {
    if (pct >= 90) return 'bg-emerald-400';
    if (pct >= 50) return 'bg-amber-400';
    return 'bg-brand-main';
}

// ─── Week label helpers (same as WeeklyDetail) ───────────────────────────────
function fmtShort(dateStr: string): string {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
}
function fmtWeekRange(start: string, end: string): string {
    return `${fmtShort(start)} — ${fmtShort(end)}`;
}
function addDaysStr(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${dt.getFullYear()}-${mm}-${dd}`;
}

export default function TasksDashboard() {
    const [tab, setTab] = useUrlState('tab', 'dashboard'); // 'dashboard' | 'hebdo'
    const isWeekly = tab === 'hebdo';

    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    const [selectedRep, setSelectedRep] = useUrlState('rep', 'Tous');
    const [selectedWeek, setSelectedWeek] = useUrlState('week', '');

    const [availableWeeks, setAvailableWeeks] = useState<TasksAvailableWeek[]>([]);
    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<TaskKPIs | null>(null);
    const [byRep, setByRep] = useState<TasksByRepRow[]>([]);
    const [byStatus, setByStatus] = useState<TasksByStatusRow[]>([]);
    const [weekly, setWeekly] = useState<TasksWeeklyRow[]>([]);
    const [wow, setWow] = useState<TasksWoWRow[]>([]);

    const repList = useRepList();

    // Available weeks for the week switcher (newest-first)
    const fetchWeeks = useCallback(async () => {
        const { data } = await supabase.rpc('get_tasks_available_weeks', { p_year: new Date().getFullYear() });
        const weeks: TasksAvailableWeek[] = data || [];
        setAvailableWeeks(weeks);
        if (weeks.length > 0 && !weeks.find(w => w.week_start === selectedWeek)) {
            setSelectedWeek(weeks[0].week_start);
        }
    }, [selectedWeek]); // eslint-disable-line react-hooks/exhaustive-deps

    const fetchData = useCallback(async () => {
        // In weekly mode wait until a week is chosen (avoids a flash of yearly data)
        if (isWeekly && !selectedWeek) { setLoading(true); return; }
        setLoading(true);
        const monthParam = isWeekly ? null : (selectedMonth === 'Toutes' ? null : selectedMonth);
        const weekParam = isWeekly ? selectedWeek : null;
        const repParam = selectedRep === 'Tous' ? null : selectedRep;

        const [
            { data: kpiData },
            { data: repData },
            { data: statusData },
            { data: weeklyData },
            { data: wowData },
        ] = await Promise.all([
            supabase.rpc('get_tasks_kpis', { p_year: year, p_month: monthParam, p_rep: repParam, p_week_start: weekParam }),
            supabase.rpc('get_tasks_by_rep', { p_year: year, p_month: monthParam, p_week_start: weekParam }),
            supabase.rpc('get_tasks_by_status', { p_rep: repParam }),
            supabase.rpc('get_tasks_weekly', { p_year: year, p_rep: repParam }),
            supabase.rpc('get_tasks_wow', { p_rep: repParam }),
        ]);

        setKpis(kpiData?.[0] ?? null);
        setByRep(repData ?? []);
        setByStatus(statusData ?? []);
        setWeekly(weeklyData ?? []);
        setWow(wowData ?? []);
        setLoading(false);
    }, [isWeekly, year, selectedMonth, selectedRep, selectedWeek]);

    const fetchDataRef = useRef(fetchData);
    const fetchWeeksRef = useRef(fetchWeeks);
    useEffect(() => { fetchDataRef.current = fetchData; fetchWeeksRef.current = fetchWeeks; }, [fetchData, fetchWeeks]);
    useEffect(() => { fetchWeeks(); }, [fetchWeeks]);
    useEffect(() => { fetchData(); }, [fetchData]);

    useEffect(() => {
        const sub = supabase
            .channel('tasks-dashboard-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_tasks' }, () => {
                fetchWeeksRef.current();
                fetchDataRef.current();
            })
            .subscribe();
        return () => { supabase.removeChannel(sub); };
    }, []);

    const { sortedData: sortedReps, sortConfig, handleSort } = useSort<TasksByRepRow>(byRep, 'nb_completed', 'desc');

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const repOptions = useMemo(() => [{ value: 'Tous', label: 'Tous les reps' }, ...repList.map(r => ({ value: r, label: r }))], [repList]);

    // Week navigation (availableWeeks is newest-first)
    const currentIdx = availableWeeks.findIndex(w => w.week_start === selectedWeek);
    const currentWeekObj = availableWeeks[currentIdx] ?? null;
    const prevWeekObj = currentIdx < availableWeeks.length - 1 ? availableWeeks[currentIdx + 1] : null;
    const nextWeekObj = currentIdx > 0 ? availableWeeks[currentIdx - 1] : null;

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Tâches CRM — Activité des représentants</h1>
                <p className="text-xs md:text-sm text-slate-400 mt-0.5">
                    Ce que chaque rep fait dans Zoho CRM. Créées / complétées / traitées sur la période — ouvertes et en retard en temps réel.
                </p>
            </div>

            {/* Tab switcher */}
            <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 w-fit">
                <TabButton active={!isWeekly} onClick={() => setTab('dashboard')}>Tableau de bord</TabButton>
                <TabButton active={isWeekly} onClick={() => setTab('hebdo')}>Hebdomadaire</TabButton>
            </div>

            {/* Period + rep filters */}
            {isWeekly ? (
                <div className="space-y-4">
                    <FilterBar>
                        <FilterGroup label="Représentant">
                            <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-44" />
                        </FilterGroup>
                    </FilterBar>
                    {/* Week switcher */}
                    <div className="flex items-center justify-between bg-white rounded-2xl border border-slate-100 shadow-card px-5 py-3">
                        <button
                            onClick={() => prevWeekObj && setSelectedWeek(prevWeekObj.week_start)}
                            disabled={!prevWeekObj}
                            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                                !prevWeekObj ? "text-slate-200 cursor-not-allowed" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50")}
                        >
                            <ChevronLeft className="w-4 h-4" />{prevWeekObj ? fmtShort(prevWeekObj.week_start) : '—'}
                        </button>
                        <div className="text-center">
                            <h3 className="text-base font-bold text-slate-900">
                                {currentWeekObj ? fmtWeekRange(currentWeekObj.week_start, currentWeekObj.week_end) : '—'}
                            </h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5">Semaine sélectionnée</p>
                        </div>
                        <button
                            onClick={() => nextWeekObj && setSelectedWeek(nextWeekObj.week_start)}
                            disabled={!nextWeekObj}
                            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                                !nextWeekObj ? "text-slate-200 cursor-not-allowed" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50")}
                        >
                            {nextWeekObj ? fmtShort(nextWeekObj.week_start) : '—'}<ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            ) : (
                <FilterBar>
                    <FilterGroup label="Année">
                        <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                    </FilterGroup>
                    <FilterGroup label="Mois">
                        <Select value={String(selectedMonth)} onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))} options={monthOptions} className="w-40" />
                    </FilterGroup>
                    <FilterGroup label="Représentant">
                        <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-44" />
                    </FilterGroup>
                </FilterBar>
            )}

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
                    <p className="text-sm text-slate-400 font-medium">Chargement des tâches...</p>
                </div>
            ) : (
                <>
                    {/* KPI strip */}
                    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 md:gap-4">
                        <KPICard title="Créées"        value={String(kpis?.total_created ?? 0)}   subText={isWeekly ? 'Cette semaine' : 'Sur la période'} icon={FilePlus2} />
                        <KPICard title="Complétées"    value={String(kpis?.total_completed ?? 0)} subText={isWeekly ? 'Cette semaine' : 'Sur la période'} icon={CheckCircle2} />
                        <KPICard title="Taux compl."   value={`${Math.min(Math.round(kpis?.completion_rate ?? 0), 100)}%`} subText="Complétées / créées" icon={Percent} highlight={(kpis?.completion_rate ?? 0) >= 80} />
                        <KPICard title="Traitées"      value={String(kpis?.total_touched ?? 0)}   subText="Modifiées" icon={Activity} />
                        <KPICard title="Ouvertes"      value={String(kpis?.total_open ?? 0)}      subText="État actuel" icon={Inbox} />
                        <KPICard title="En retard"     value={String(kpis?.total_overdue ?? 0)}   subText="Échéance dépassée" icon={AlertTriangle} danger={(kpis?.total_overdue ?? 0) > 0} />
                    </div>

                    {/* Rep leaderboard — the core comparison */}
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                            <h3 className="text-sm font-bold text-slate-800">Classement des représentants</h3>
                            <span className="text-[11px] text-slate-400">{sortedReps.length} reps · {kpis?.active_reps ?? 0} actifs {isWeekly ? 'cette semaine' : 'sur la période'}</span>
                        </div>
                        {sortedReps.length === 0 ? (
                            <p className="px-5 py-10 text-sm text-slate-400 text-center">Aucune tâche pour cette période</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm min-w-[820px]">
                                    <thead>
                                        <tr className="border-b border-slate-50 bg-slate-50/60">
                                            <SortTh label="Représentant" col="rep_name" align="left" sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Créées"      col="nb_created"        sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Complétées"  col="nb_completed"      sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Taux compl." col="completion_rate"   sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Traitées"    col="nb_touched"        sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Délai moyen" col="avg_days_to_close" sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Ouvertes"    col="nb_open"           sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="En retard"   col="nb_overdue"        sortConfig={sortConfig} onSort={handleSort} />
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-50">
                                        {sortedReps.map(r => {
                                            const rate = Number(r.completion_rate) || 0;
                                            return (
                                                <tr key={r.rep_name} className="hover:bg-slate-50/60 transition-colors">
                                                    <td className="px-4 py-3 font-semibold text-slate-700 whitespace-nowrap">{r.rep_name}</td>
                                                    <td className="px-4 py-3 text-right font-bold text-slate-700 tabular-nums">{r.nb_created}</td>
                                                    <td className="px-4 py-3 text-right tabular-nums"><span className="font-bold text-emerald-600">{r.nb_completed}</span></td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center justify-end gap-2">
                                                            <div className="h-1.5 rounded-full bg-slate-100 w-16 shrink-0">
                                                                <div className={cn('h-1.5 rounded-full', pctBar(rate))} style={{ width: `${Math.min(rate, 100)}%` }} />
                                                            </div>
                                                            <span className={cn('text-xs font-bold tabular-nums w-9 text-right', pctText(rate))}>{Math.min(Math.round(rate), 100)}%</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-slate-500 tabular-nums">{r.nb_touched}</td>
                                                    <td className="px-4 py-3 text-right text-slate-500 tabular-nums">
                                                        {r.avg_days_to_close != null ? `${Number(r.avg_days_to_close).toFixed(1)} j` : <span className="text-slate-300">—</span>}
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-slate-500 tabular-nums">{r.nb_open}</td>
                                                    <td className="px-4 py-3 text-right tabular-nums">
                                                        <span className={cn('font-bold', r.nb_overdue > 0 ? 'text-red-500' : 'text-slate-300')}>{r.nb_overdue}</span>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Week-over-week + open tasks by status */}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6">
                        <WeekOverWeekPanel rows={wow} />
                        <StatusPanel rows={byStatus} />
                    </div>

                    {/* Weekly trend */}
                    <WeeklyTrend rows={weekly} />
                </>
            )}
        </div>
    );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'px-4 py-1.5 rounded-lg text-sm font-semibold transition-all',
                active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
        >
            {children}
        </button>
    );
}

// ─── Sortable header cell ───────────────────────────────────────────────────

function SortTh<T>({ label, col, align = 'right', sortConfig, onSort }: {
    label: string;
    col: keyof T;
    align?: 'left' | 'right';
    sortConfig: { key: keyof T | null; order: 'asc' | 'desc' | null };
    onSort: (key: keyof T) => void;
}) {
    const active = sortConfig.key === col ? sortConfig.order : null;
    return (
        <th className={cn('px-4 py-2.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest', align === 'left' ? 'text-left' : 'text-right')}>
            <button onClick={() => onSort(col)} className={cn('group inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
                {label}
                <SortIcon order={active} />
            </button>
        </th>
    );
}

// ─── Week-over-week panel ───────────────────────────────────────────────────

function WeekOverWeekPanel({ rows }: { rows: TasksWoWRow[] }) {
    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-800">Cette semaine vs semaine dernière</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">Tâches complétées, par rep — qui accélère, qui ralentit</p>
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-400 text-center">Aucune activité récente</p>
            ) : (
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-50 bg-slate-50/60">
                            <th className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rep</th>
                            <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Sem. dern.</th>
                            <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Cette sem.</th>
                            <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Évol.</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {rows.map(r => {
                            const delta = r.completed_this_week - r.completed_last_week;
                            const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
                            const color = delta > 0 ? 'text-emerald-500' : delta < 0 ? 'text-red-500' : 'text-slate-300';
                            return (
                                <tr key={r.rep_name} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-4 py-2.5 font-semibold text-slate-700">{r.rep_name}</td>
                                    <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">{r.completed_last_week}</td>
                                    <td className="px-4 py-2.5 text-right font-bold text-slate-800 tabular-nums">{r.completed_this_week}</td>
                                    <td className="px-4 py-2.5 text-right">
                                        <span className={cn('inline-flex items-center gap-1 text-xs font-bold tabular-nums', color)}>
                                            <Icon className="w-3.5 h-3.5" />
                                            {delta > 0 ? `+${delta}` : delta}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

// ─── Open tasks by status ───────────────────────────────────────────────────

function StatusPanel({ rows }: { rows: TasksByStatusRow[] }) {
    const total = rows.reduce((s, r) => s + r.nb, 0);
    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-800">Tâches ouvertes par statut</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">Composition du backlog — beaucoup de « Non commencé » = tâches créées mais pas travaillées</p>
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-400 text-center">Aucune tâche ouverte</p>
            ) : (
                <div className="p-5 space-y-3">
                    {rows.map(r => {
                        const pct = total > 0 ? Math.round((r.nb / total) * 100) : 0;
                        return (
                            <div key={r.status} className="flex items-center gap-3">
                                <span className={cn('shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase w-32 text-center', STATUS_COLORS[r.status] ?? 'bg-slate-100 text-slate-500')}>
                                    {STATUS_LABELS[r.status] ?? r.status}
                                </span>
                                <div className="flex-1 h-2 rounded-full bg-slate-100">
                                    <div className={cn('h-2 rounded-full', STATUS_BAR[r.status] ?? 'bg-slate-300')} style={{ width: `${pct}%` }} />
                                </div>
                                <span className="shrink-0 w-16 text-right text-xs tabular-nums">
                                    <span className="font-bold text-slate-700">{r.nb}</span>
                                    <span className="text-slate-400 ml-1">{pct}%</span>
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Weekly trend ───────────────────────────────────────────────────────────

function WeeklyTrend({ rows }: { rows: TasksWeeklyRow[] }) {
    const active = rows.filter(w => w.nb_created > 0 || w.nb_completed > 0);
    const maxVal = Math.max(1, ...active.map(w => Math.max(w.nb_created, w.nb_completed)));

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-bold text-slate-800">Tendance hebdomadaire</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">Tâches créées vs complétées, par semaine</p>
                </div>
                <div className="flex items-center gap-4 text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-slate-300" /> Créées</span>
                    <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-brand-main" /> Complétées</span>
                </div>
            </div>
            {active.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-400 text-center">Aucune donnée hebdomadaire</p>
            ) : (
                <div className="p-5 pt-20 overflow-x-auto">
                    <div className="flex items-end gap-3 h-32 min-w-min">
                        {active.map(w => {
                            const label = fmtShort(w.week_start);
                            const range = fmtWeekRange(w.week_start, addDaysStr(w.week_start, 6));
                            const rate = w.nb_created > 0 ? Math.min(Math.round((w.nb_completed / w.nb_created) * 100), 100) : 0;
                            return (
                                <div key={w.week_start} className="group relative flex flex-col items-center gap-1.5 shrink-0 rounded-lg px-0.5 pt-1 hover:bg-slate-50 transition-colors">
                                    {/* Hover tooltip */}
                                    <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 hidden group-hover:block">
                                        <div className="bg-slate-900 text-white rounded-lg px-3 py-2 shadow-xl text-[11px] whitespace-nowrap">
                                            <div className="font-bold mb-1 text-center">{range}</div>
                                            <div className="flex items-center gap-3">
                                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-400" /><span className="tabular-nums font-bold">{w.nb_created}</span> créées</span>
                                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-brand-main" /><span className="tabular-nums font-bold">{w.nb_completed}</span> compl.</span>
                                                <span className="tabular-nums font-bold text-emerald-400">{rate}%</span>
                                            </div>
                                        </div>
                                        <div className="w-2 h-2 bg-slate-900 rotate-45 absolute left-1/2 -translate-x-1/2 -bottom-1" />
                                    </div>

                                    <div className="flex items-end gap-1 h-24">
                                        <div className="w-3 rounded-t bg-slate-300 group-hover:bg-slate-400 transition-colors" style={{ height: `${(w.nb_created / maxVal) * 100}%` }} />
                                        <div className="w-3 rounded-t bg-brand-main group-hover:bg-amber-600 transition-colors" style={{ height: `${(w.nb_completed / maxVal) * 100}%` }} />
                                    </div>
                                    <span className="text-[9px] text-slate-400 group-hover:text-slate-700 whitespace-nowrap transition-colors">{label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── KPI card ───────────────────────────────────────────────────────────────

function KPICard({ title, value, subText, icon: Icon, highlight, danger }: {
    title: string; value: string; subText: string; icon: React.ElementType; highlight?: boolean; danger?: boolean;
}) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-2xl border border-slate-100 shadow-card flex flex-col justify-between hover:shadow-card-hover transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className={cn(
                    'p-2 md:p-2.5 rounded-xl transition-colors',
                    danger ? 'bg-red-50 text-red-500' : 'bg-slate-50 text-slate-400 group-hover:text-brand-main group-hover:bg-amber-50',
                )}>
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                {highlight && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Bon</span>
                )}
            </div>
            <div>
                <p className="text-[10px] md:text-xs font-semibold text-slate-400 uppercase tracking-widest leading-tight">{title}</p>
                <p className="mt-1 text-base md:text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
                <p className="text-[10px] md:text-[11px] text-slate-400 mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
