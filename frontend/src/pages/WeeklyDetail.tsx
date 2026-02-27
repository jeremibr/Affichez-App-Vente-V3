import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, formatShortDate } from '../lib/utils';
import { Loader2, Calendar, TrendingUp, Briefcase, Users } from 'lucide-react';
import type { AvailableWeek, ZoneA_SummaryRow, ZoneA_DeptTotal, ZoneB_DetailRow } from '../types/database';
import { ZoneAPivotTable } from '../components/weekly/ZoneAPivotTable';
import { ZoneBTable } from '../components/weekly/ZoneBTable';
import { DEPARTMENTS, OFFICES, SALE_STATUSES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';

export default function WeeklyDetail() {
    const [year, setYear] = useState<number>(2026);
    const [availableWeeks, setAvailableWeeks] = useState<AvailableWeek[]>([]);
    const [selectedWeek, setSelectedWeek] = useState<string>('');

    const [selectedDept, setSelectedDept] = useState<string>('Toutes');
    const [selectedRep, setSelectedRep] = useState<string>('Tous');
    const [selectedOffice, setSelectedOffice] = useState<string>('Toutes');
    const [selectedStatus, setSelectedStatus] = useState<string>('Toutes');

    const [loading, setLoading] = useState(false);
    const [summaryData, setSummaryData] = useState<ZoneA_SummaryRow[]>([]);
    const [lineItems, setLineItems] = useState<ZoneB_DetailRow[]>([]);

    const clearData = () => { setSummaryData([]); setLineItems([]); };

    const fetchAvailableWeeks = useCallback(async (showLoader = true) => {
        if (showLoader) setLoading(true);
        const { data } = await supabase.rpc('get_available_weeks', {
            p_year: year,
            p_office: selectedOffice === 'Toutes' ? null : selectedOffice,
            p_status: selectedStatus === 'Toutes' ? null : selectedStatus
        });
        const weeks = data || [];
        setAvailableWeeks(weeks);
        if (weeks.length > 0) {
            if (!weeks.find((w: AvailableWeek) => w.week_start === selectedWeek)) {
                setSelectedWeek(weeks[0].week_start);
            }
        } else { setSelectedWeek(''); clearData(); }
        if (showLoader) setLoading(false);
    }, [year, selectedOffice, selectedStatus, selectedWeek]);

    const fetchWeekData = useCallback(async (weekStart: string, showLoader = true) => {
        if (showLoader) setLoading(true);
        let summaryQuery = supabase.from('v_weekly_summary').select('*').eq('week_start', weekStart);
        if (selectedOffice !== 'Toutes') summaryQuery = summaryQuery.eq('office', selectedOffice);
        if (selectedStatus !== 'Toutes') summaryQuery = summaryQuery.eq('status', selectedStatus);

        const [{ data: sData }, { data: lData }] = await Promise.all([
            summaryQuery,
            supabase.rpc('get_weekly_detail', {
                p_week_start: weekStart,
                p_office: selectedOffice === 'Toutes' ? null : selectedOffice,
                p_status: selectedStatus === 'Toutes' ? null : selectedStatus
            })
        ]);
        setSummaryData(sData || []);
        setLineItems(lData || []);
        if (showLoader) setLoading(false);
    }, [selectedOffice, selectedStatus]);

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

    const uniqueReps = useMemo(() => {
        const reps = new Set<string>();
        summaryData.forEach(row => reps.add(row.rep_name));
        return Array.from(reps).sort((a, b) => a.localeCompare(b));
    }, [summaryData]);

    const filteredSummaryData = useMemo(() => summaryData.filter(row => {
        const matchDept = selectedDept === 'Toutes' || row.department === selectedDept;
        const matchRep = selectedRep === 'Tous' || row.rep_name === selectedRep;
        return matchDept && matchRep;
    }), [summaryData, selectedDept, selectedRep]);

    const filteredLineItems = useMemo(() => lineItems.filter(row => {
        const matchDept = selectedDept === 'Toutes' || row.department === selectedDept;
        const matchRep = selectedRep === 'Tous' || row.rep_name === selectedRep;
        return matchDept && matchRep;
    }), [lineItems, selectedDept, selectedRep]);

    const filteredGrandTotal = useMemo(() =>
        filteredSummaryData.reduce((sum, row) => sum + Number(row.total_amount), 0),
        [filteredSummaryData]);

    const avgTicket = useMemo(() =>
        filteredLineItems.length > 0 ? filteredGrandTotal / filteredLineItems.length : 0
        , [filteredGrandTotal, filteredLineItems]);

    const filteredDeptTotals = useMemo(() => {
        const map = new Map<string, ZoneA_DeptTotal>();
        filteredSummaryData.forEach(row => {
            if (!map.has(row.department)) map.set(row.department, { department: row.department, total_amount: 0, num_sales: 0 });
            const dt = map.get(row.department)!;
            dt.total_amount += Number(row.total_amount);
            dt.num_sales += Number(row.num_sales);
        });
        return Array.from(map.values());
    }, [filteredSummaryData]);

    const repPivotRows = useMemo(() => {
        const repsMap = new Map<string, Record<string, number>>();
        filteredSummaryData.forEach(row => {
            if (!repsMap.has(row.rep_name)) repsMap.set(row.rep_name, { "Total": 0 });
            const r = repsMap.get(row.rep_name)!;
            r[row.department] = (r[row.department] || 0) + Number(row.total_amount);
            r["Total"] += Number(row.total_amount);
        });
        return Array.from(repsMap.entries()).map(([repName, depts]) => ({ repName, ...depts }))
            .sort((a, b) => a.repName.localeCompare(b.repName));
    }, [filteredSummaryData]);

    // Options for Selects
    const weekOptions = useMemo(() => availableWeeks.map(w => ({
        value: w.week_start,
        label: `${formatShortDate(w.week_start)} — ${formatShortDate(w.week_end)}`
    })), [availableWeeks]);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const statusOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous les devis' }, ...SALE_STATUSES], []);
    const deptOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous services' }, ...DEPARTMENTS.map(d => ({ value: d, label: d }))], []);
    const repOptions = useMemo(() => [{ value: 'Tous', label: 'Tous les reps' }, ...uniqueReps.map(r => ({ value: r, label: r }))], [uniqueReps]);
    const yearOptions = [2025, 2026].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="p-6 md:p-8 max-w-screen-2xl mx-auto space-y-8">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Détail Hebdomadaire</h1>
                <p className="text-sm text-slate-400 mt-0.5">
                    {selectedWeek ? <>Performance pour la semaine du <span className="text-brand-main font-bold">{formatShortDate(selectedWeek)}</span></> : 'Sélectionnez une période'}
                </p>
            </div>

            {/* Combined Filters */}
            <FilterBar>
                <FilterGroup label="Semaine">
                    <Select value={selectedWeek} onChange={setSelectedWeek} options={weekOptions} variant="accent" className="w-64" disabled={availableWeeks.length === 0} />
                </FilterGroup>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(v) => setYear(Number(v))} options={yearOptions} className="w-24" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-40" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <Select value={selectedStatus} onChange={setSelectedStatus} options={statusOptions} className="w-36" />
                </FilterGroup>
                <FilterGroup label="Département">
                    <Select value={selectedDept} onChange={setSelectedDept} options={deptOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-40" />
                </FilterGroup>
            </FilterBar>

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
                    <p className="text-sm text-slate-400 mt-1">Essayez de modifier l'année ou les filtres de siège.</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {/* KPI Cards for the week */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="bg-brand-main rounded-2xl p-6 text-white shadow-lg shadow-brand-main/20 flex items-center justify-between">
                            <div>
                                <p className="text-white/60 text-[10px] font-black uppercase tracking-widest">Total Hebdomadaire</p>
                                <p className="text-3xl font-black mt-1">{formatCurrencyCAD(filteredGrandTotal)}</p>
                            </div>
                            <div className="p-3 bg-white/10 rounded-xl">
                                <TrendingUp className="w-6 h-6" />
                            </div>
                        </div>
                        <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-card flex items-center justify-between group hover:border-brand-main/20 transition-all">
                            <div>
                                <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Vente Moyenne</p>
                                <p className="text-2xl font-black text-slate-800 mt-1">{formatCurrencyCAD(avgTicket)}</p>
                            </div>
                            <div className="p-3 bg-slate-50 rounded-xl text-slate-300 group-hover:bg-amber-50 group-hover:text-brand-main transition-colors">
                                <Briefcase className="w-6 h-6" />
                            </div>
                        </div>
                        <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-card flex items-center justify-between group hover:border-brand-main/20 transition-all">
                            <div>
                                <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Volume d'affaires</p>
                                <p className="text-2xl font-black text-slate-800 mt-1">{filteredLineItems.length} Devis</p>
                            </div>
                            <div className="p-3 bg-slate-50 rounded-xl text-slate-300 group-hover:bg-amber-50 group-hover:text-brand-main transition-colors">
                                <Users className="w-6 h-6" />
                            </div>
                        </div>
                    </div>

                    <ZoneAPivotTable repPivotRows={repPivotRows} grandTotal={filteredGrandTotal} deptTotals={filteredDeptTotals} />
                    <ZoneBTable lineItems={filteredLineItems} />
                </div>
            )}
        </div>
    );
}
