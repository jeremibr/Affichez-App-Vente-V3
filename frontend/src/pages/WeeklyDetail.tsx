import { useEffect, useState, useMemo, useCallback } from 'react';
import { useUrlState } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD } from '../lib/utils';
import { Loader2, Calendar, TrendingUp, Briefcase, Users, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AvailableWeek, ZoneA_SummaryRow, ZoneA_DeptTotal, ZoneB_DetailRow } from '../types/database';
import { ZoneAPivotTable } from '../components/weekly/ZoneAPivotTable';
import { ZoneBTable } from '../components/weekly/ZoneBTable';
import { cn } from '../lib/utils';
import { Select } from '../components/Select';
import { useRepList } from '../hooks/useRepList';

// ─── Week label helpers ───────────────────────────────────────────────────────

function fmtShort(dateStr: string): string {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
}

function fmtWeekRange(start: string, end: string): string {
    return `${fmtShort(start)} — ${fmtShort(end)}`;
}

export default function WeeklyDetail() {
    const [availableWeeks, setAvailableWeeks] = useState<AvailableWeek[]>([]);
    const [selectedWeek, setSelectedWeek] = useUrlState('week', '');
    const [selectedRep, setSelectedRep] = useState('');
    const [loading, setLoading] = useState(false);
    const [summaryData, setSummaryData] = useState<ZoneA_SummaryRow[]>([]);
    const [lineItems, setLineItems] = useState<ZoneB_DetailRow[]>([]);
    const repList = useRepList();

    const clearData = () => { setSummaryData([]); setLineItems([]); };

    const fetchAvailableWeeks = useCallback(async (showLoader = true) => {
        if (showLoader) setLoading(true);
        const { data } = await supabase.rpc('get_available_weeks', { p_year: new Date().getFullYear(), p_office: null, p_status: null });
        const weeks = data || [];
        setAvailableWeeks(weeks);
        if (weeks.length > 0) {
            if (!weeks.find((w: AvailableWeek) => w.week_start === selectedWeek)) {
                setSelectedWeek(weeks[0].week_start);
            }
        } else { setSelectedWeek(''); clearData(); }
        if (showLoader) setLoading(false);
    }, [selectedWeek]); // eslint-disable-line react-hooks/exhaustive-deps

    const fetchWeekData = useCallback(async (weekStart: string, showLoader = true) => {
        if (showLoader) setLoading(true);
        const [{ data: sData }, { data: lData }] = await Promise.all([
            supabase.from('v_weekly_summary').select('*').eq('week_start', weekStart),
            supabase.rpc('get_weekly_detail', { p_week_start: weekStart, p_office: null, p_status: null })
        ]);
        setSummaryData(sData || []);
        setLineItems(lData || []);
        if (showLoader) setLoading(false);
    }, []);

    useEffect(() => { fetchAvailableWeeks(); }, [fetchAvailableWeeks]);
    useEffect(() => { if (selectedWeek) fetchWeekData(selectedWeek); }, [selectedWeek, fetchWeekData]);
    useEffect(() => {
        const channel = supabase.channel('weekly-sales')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => {
                fetchAvailableWeeks(false);
                if (selectedWeek) fetchWeekData(selectedWeek, false);
            }).subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [selectedWeek, fetchAvailableWeeks, fetchWeekData]);

    // Week navigation (availableWeeks is newest-first)
    const currentIdx = availableWeeks.findIndex(w => w.week_start === selectedWeek);
    const currentWeekObj = availableWeeks[currentIdx] ?? null;
    const prevWeekObj = currentIdx < availableWeeks.length - 1 ? availableWeeks[currentIdx + 1] : null;
    const nextWeekObj = currentIdx > 0 ? availableWeeks[currentIdx - 1] : null;

    const filteredSummary = useMemo(() =>
        selectedRep ? summaryData.filter(r => r.rep_name === selectedRep) : summaryData,
        [summaryData, selectedRep]);

    const filteredLineItems = useMemo(() =>
        selectedRep ? lineItems.filter(r => r.rep_name === selectedRep) : lineItems,
        [lineItems, selectedRep]);

    const grandTotal = useMemo(() =>
        filteredSummary.reduce((sum, row) => sum + Number(row.total_amount), 0), [filteredSummary]);

    const avgTicket = useMemo(() =>
        filteredLineItems.length > 0 ? grandTotal / filteredLineItems.length : 0, [grandTotal, filteredLineItems]);

    const deptTotals = useMemo(() => {
        const map = new Map<string, ZoneA_DeptTotal>();
        filteredSummary.forEach(row => {
            if (!map.has(row.department)) map.set(row.department, { department: row.department, total_amount: 0, num_sales: 0 });
            const dt = map.get(row.department)!;
            dt.total_amount += Number(row.total_amount);
            dt.num_sales += Number(row.num_sales);
        });
        return Array.from(map.values());
    }, [filteredSummary]);

    const repPivotRows = useMemo(() => {
        const repsMap = new Map<string, Record<string, number>>();
        filteredSummary.forEach(row => {
            if (!repsMap.has(row.rep_name)) repsMap.set(row.rep_name, { "Total": 0 });
            const r = repsMap.get(row.rep_name)!;
            r[row.department] = (r[row.department] || 0) + Number(row.total_amount);
            r["Total"] += Number(row.total_amount);
        });
        return Array.from(repsMap.entries()).map(([repName, depts]) => ({ repName, ...depts }))
            .sort((a, b) => a.repName.localeCompare(b.repName));
    }, [filteredSummary]);

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Détail Hebdomadaire</h1>
                    <p className="text-xs md:text-sm text-slate-400 mt-0.5">Devis — Vue équipe complète</p>
                </div>
                <div className="rounded-lg border border-brand-main/40">
                    <Select
                        value={selectedRep}
                        onChange={setSelectedRep}
                        options={[
                            { value: '', label: 'Tous les reps' },
                            ...repList.map(r => ({ value: r, label: r })),
                        ]}
                        variant={selectedRep ? 'accent' : 'default'}
                        className="w-48"
                    />
                </div>
            </div>

            {/* Week switcher */}
            <div className="flex items-center justify-between bg-white rounded-2xl border border-slate-100 shadow-card px-5 py-3">
                <button
                    onClick={() => prevWeekObj && setSelectedWeek(prevWeekObj.week_start)}
                    disabled={!prevWeekObj}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                        !prevWeekObj ? "text-slate-200 cursor-not-allowed" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                    )}
                >
                    <ChevronLeft className="w-4 h-4" />
                    {prevWeekObj ? fmtShort(prevWeekObj.week_start) : '—'}
                </button>

                <div className="text-center">
                    <h3 className="text-base font-bold text-slate-900">
                        {currentWeekObj ? fmtWeekRange(currentWeekObj.week_start, currentWeekObj.week_end) : '—'}
                    </h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5">
                        Détail des devis
                    </p>
                </div>

                <button
                    onClick={() => nextWeekObj && setSelectedWeek(nextWeekObj.week_start)}
                    disabled={!nextWeekObj}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                        !nextWeekObj ? "text-slate-200 cursor-not-allowed" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                    )}
                >
                    {nextWeekObj ? fmtShort(nextWeekObj.week_start) : '—'}
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
                    <p className="text-sm text-slate-400 font-medium">Récupération des détails...</p>
                </div>
            ) : availableWeeks.length === 0 ? (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-card p-20 text-center">
                    <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Calendar className="w-8 h-8 text-slate-200" />
                    </div>
                    <h3 className="text-base font-bold text-slate-700">Aucune vente enregistrée</h3>
                    <p className="text-sm text-slate-400 mt-1">Essayez de modifier l'année.</p>
                </div>
            ) : (
                <div className="space-y-4 md:space-y-6">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-6">
                        <div className="bg-brand-main rounded-2xl p-3 md:p-6 text-white shadow-lg shadow-brand-main/20 flex items-center justify-between">
                            <div className="min-w-0">
                                <p className="text-white/60 text-[9px] md:text-[10px] font-black uppercase tracking-widest">Total Hebdo</p>
                                <p className="text-base md:text-3xl font-black mt-1 tabular-nums truncate">{formatCurrencyCAD(grandTotal)}</p>
                            </div>
                            <div className="p-2 md:p-3 bg-white/10 rounded-xl shrink-0 ml-2">
                                <TrendingUp className="w-4 h-4 md:w-6 md:h-6" />
                            </div>
                        </div>
                        <div className="hidden sm:flex bg-white rounded-2xl p-3 md:p-6 border border-slate-100 shadow-card items-center justify-between group hover:border-brand-main/20 transition-all">
                            <div className="min-w-0">
                                <p className="text-slate-400 text-[9px] md:text-[10px] font-black uppercase tracking-widest">Moy./vente</p>
                                <p className="text-base md:text-2xl font-black text-slate-800 mt-1 tabular-nums truncate">{formatCurrencyCAD(avgTicket)}</p>
                            </div>
                            <div className="p-2 md:p-3 bg-slate-50 rounded-xl text-slate-300 group-hover:bg-amber-50 group-hover:text-brand-main transition-colors shrink-0 ml-2 hidden sm:flex">
                                <Briefcase className="w-4 h-4 md:w-6 md:h-6" />
                            </div>
                        </div>
                        <div className="bg-white rounded-2xl p-3 md:p-6 border border-slate-100 shadow-card flex items-center justify-between group hover:border-brand-main/20 transition-all">
                            <div className="min-w-0">
                                <p className="text-slate-400 text-[9px] md:text-[10px] font-black uppercase tracking-widest">Volume</p>
                                <p className="text-base md:text-2xl font-black text-slate-800 mt-1">{filteredLineItems.length} <span className="text-xs md:text-base">Devis</span></p>
                            </div>
                            <div className="p-2 md:p-3 bg-slate-50 rounded-xl text-slate-300 group-hover:bg-amber-50 group-hover:text-brand-main transition-colors shrink-0 ml-2 hidden sm:flex">
                                <Users className="w-4 h-4 md:w-6 md:h-6" />
                            </div>
                        </div>
                    </div>

                    <ZoneAPivotTable repPivotRows={repPivotRows} grandTotal={grandTotal} deptTotals={deptTotals} />
                    <ZoneBTable lineItems={filteredLineItems} />
                </div>
            )}
        </div>
    );
}
