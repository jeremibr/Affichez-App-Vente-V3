import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Loader2, TrendingUp, Users, Percent, DollarSign } from 'lucide-react';
import type { LeadKPIs, LeadsByRepRow, LeadsBySourceRow, LeadsByServiceRow } from '../types/database';
import { LEAD_SOURCES, LEAD_SERVICES, MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useRepList } from '../hooks/useRepList';

export default function LeadsDashboard() {
    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    const [selectedRep, setSelectedRep] = useUrlState('rep', 'Tous');
    const [selectedSource, setSelectedSource] = useUrlState('source', 'Toutes');
    const [selectedService, setSelectedService] = useUrlState('service', 'Tous');

    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<LeadKPIs | null>(null);
    const [byRep, setByRep] = useState<LeadsByRepRow[]>([]);
    const [bySource, setBySource] = useState<LeadsBySourceRow[]>([]);
    const [byService, setByService] = useState<LeadsByServiceRow[]>([]);

    const repList = useRepList();

    const fetchData = useCallback(async () => {
        setLoading(true);
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;
        const repParam = selectedRep === 'Tous' ? null : selectedRep;
        const sourceParam = selectedSource === 'Toutes' ? null : selectedSource;
        const serviceParam = selectedService === 'Tous' ? null : selectedService;

        const [
            { data: kpiData },
            { data: repData },
            { data: srcData },
            { data: svcData },
        ] = await Promise.all([
            supabase.rpc('get_leads_kpis', { p_year: year, p_month: monthParam, p_rep: repParam, p_source: sourceParam, p_service: serviceParam }),
            supabase.rpc('get_leads_by_rep', { p_year: year, p_month: monthParam, p_source: sourceParam, p_service: serviceParam }),
            supabase.rpc('get_leads_by_source', { p_year: year, p_month: monthParam, p_rep: repParam, p_service: serviceParam }),
            supabase.rpc('get_leads_by_service', { p_year: year, p_month: monthParam, p_rep: repParam, p_source: sourceParam }),
        ]);

        setKpis(kpiData?.[0] ?? null);
        setByRep(repData ?? []);
        setBySource(srcData ?? []);
        setByService(svcData ?? []);
        setLoading(false);
    }, [year, selectedMonth, selectedRep, selectedSource, selectedService]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);

    useEffect(() => {
        const sub = supabase
            .channel('leads-dashboard-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => fetchDataRef.current())
            .subscribe();
        return () => { supabase.removeChannel(sub); };
    }, []);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const repOptions = useMemo(() => [{ value: 'Tous', label: 'Tous les reps' }, ...repList.map(r => ({ value: r, label: r }))], [repList]);
    const sourceOptions = useMemo(() => [{ value: 'Toutes', label: 'Toutes les sources' }, ...LEAD_SOURCES.map(s => ({ value: s.value, label: s.label }))], []);
    const serviceOptions = useMemo(() => [{ value: 'Tous', label: 'Tous les services' }, ...LEAD_SERVICES.map(s => ({ value: s.value, label: s.label }))], []);

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Leads — Tableau de bord</h1>
                <p className="text-xs md:text-sm text-slate-400 mt-0.5">Vue d'ensemble des leads entrants et des conversions</p>
            </div>

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
                <FilterGroup label="Source">
                    <Select value={selectedSource} onChange={setSelectedSource} options={sourceOptions} className="w-52" />
                </FilterGroup>
                <FilterGroup label="Service">
                    <Select value={selectedService} onChange={setSelectedService} options={serviceOptions} className="w-48" />
                </FilterGroup>
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
                    <p className="text-sm text-slate-400 font-medium">Chargement des données leads...</p>
                </div>
            ) : (
                <>
                    {/* KPI Cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        <KPICard title="Total leads" value={String(kpis?.total_leads ?? 0)} subText="Leads reçus" icon={Users} />
                        <KPICard title="Leads vendus" value={String(kpis?.won_leads ?? 0)} subText="Deals conclus" icon={TrendingUp} />
                        <KPICard
                            title="Taux de conversion"
                            value={`${(kpis?.conversion_rate ?? 0).toFixed(1)}%`}
                            subText="Leads → Vente"
                            icon={Percent}
                            highlight={(kpis?.conversion_rate ?? 0) >= 20}
                        />
                        <KPICard title="Revenus générés" value={formatCurrencyCAD(kpis?.total_amount ?? 0)} subText="Montant vendu" icon={DollarSign} />
                    </div>

                    {/* Three breakdown tables */}
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-6">
                        <LeadsBreakdownTable
                            title="Par représentant"
                            rows={byRep.map(r => ({ label: r.rep_name, nb_leads: r.nb_leads, nb_won: r.nb_won, total_amount: r.total_amount }))}
                        />
                        <LeadsBreakdownTable
                            title="Par source"
                            rows={bySource.map(r => ({ label: r.source, nb_leads: r.nb_leads, nb_won: r.nb_won, total_amount: r.total_amount }))}
                            labelMap={Object.fromEntries(LEAD_SOURCES.map(s => [s.value, s.label]))}
                        />
                        <LeadsBreakdownTable
                            title="Par service"
                            rows={byService.map(r => ({ label: r.service_interest, nb_leads: r.nb_leads, nb_won: r.nb_won, total_amount: r.total_amount }))}
                        />
                    </div>
                </>
            )}
        </div>
    );
}

interface BreakdownRow { label: string; nb_leads: number; nb_won: number; total_amount: number; }

function LeadsBreakdownTable({ title, rows, labelMap }: { title: string; rows: BreakdownRow[]; labelMap?: Record<string, string> }) {
    const total_leads = rows.reduce((s, r) => s + r.nb_leads, 0);
    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-800">{title}</h3>
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-400 text-center">Aucun lead</p>
            ) : (
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-50 bg-slate-50/60">
                            <th className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Nom</th>
                            <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Leads</th>
                            <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Vendus</th>
                            <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Revenus</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {rows.map(r => {
                            const pct = total_leads > 0 ? Math.round((r.nb_leads / total_leads) * 100) : 0;
                            const convRate = r.nb_leads > 0 ? ((r.nb_won / r.nb_leads) * 100).toFixed(0) : '0';
                            return (
                                <tr key={r.label} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-4 py-2.5">
                                        <p className="font-semibold text-slate-700 text-xs truncate max-w-[130px]" title={labelMap?.[r.label] ?? r.label}>
                                            {labelMap?.[r.label] ?? r.label}
                                        </p>
                                        <div className="mt-1 h-1 rounded-full bg-slate-100 w-full max-w-[100px]">
                                            <div className="h-1 rounded-full bg-brand-main" style={{ width: `${pct}%` }} />
                                        </div>
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-bold text-slate-700 tabular-nums">{r.nb_leads}</td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                        <span className="font-bold text-slate-700">{r.nb_won}</span>
                                        <span className={cn("ml-1 text-[10px] font-bold", Number(convRate) >= 20 ? "text-emerald-500" : "text-slate-400")}>
                                            ({convRate}%)
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-bold text-slate-900 tabular-nums text-xs">{formatCurrencyCAD(r.total_amount)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function KPICard({ title, value, subText, icon: Icon, highlight }: { title: string; value: string; subText: string; icon: React.ElementType; highlight?: boolean }) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-2xl border border-slate-100 shadow-card flex flex-col justify-between hover:shadow-card-hover transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className="p-2 md:p-2.5 bg-slate-50 rounded-xl text-slate-400 group-hover:text-brand-main group-hover:bg-amber-50 transition-colors">
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
