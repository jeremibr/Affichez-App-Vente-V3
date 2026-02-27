import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { Loader2, TrendingUp, Users, Target, Briefcase, Trophy, User } from 'lucide-react';
import type { SommaireRow } from '../types/database';
import { SommaireTable } from '../components/dashboard/SommaireTable';
import { DEPARTMENTS, MONTHS, OFFICES, SALE_STATUSES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';

interface DashboardKPIs {
    ytd_total: number;
    ytd_count: number;
    avg_deal_size: number;
    annual_target: number;
    pct_of_target: number;
    invoiced_total: number;
    accepted_total: number;
}

interface TopClient {
    client_name: string;
    total_amount: number;
    deal_count: number;
    office: string;
}

interface LeaderboardEntry {
    rep_name: string;
    office: string;
    total_amount: number;
    deal_count: number;
    avg_deal: number;
    rank: number;
}

export default function Dashboard() {
    const [year, setYear] = useState<number>(2026);
    const [selectedOffice, setSelectedOffice] = useState<string>('Toutes');
    const [selectedStatus, setSelectedStatus] = useState<string>('Toutes');
    const [selectedDept, setSelectedDept] = useState<string>('Toutes');
    const [selectedMonth, setSelectedMonth] = useState<number | 'Toutes'>('Toutes');

    const [loading, setLoading] = useState(true);
    const [grandTotalData, setGrandTotalData] = useState<SommaireRow[]>([]);
    const [deptData, setDeptData] = useState<SommaireRow[]>([]);
    const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
    const [topClients, setTopClients] = useState<TopClient[]>([]);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        const officeParam = selectedOffice === 'Toutes' ? null : selectedOffice;
        const statusParam = selectedStatus === 'Toutes' ? null : selectedStatus;

        const [
            { data: grandData },
            { data: dData },
            { data: kpiData },
            { data: clientData },
            { data: leaderData }
        ] = await Promise.all([
            supabase.rpc('get_sommaire_grand_total', { p_year: year, p_office: officeParam, p_status: statusParam }),
            supabase.rpc('get_sommaire', { p_year: year, p_office: officeParam, p_status: statusParam }),
            supabase.rpc('get_dashboard_kpis', { p_year: year, p_office: officeParam, p_status: statusParam }),
            supabase.rpc('get_top_clients', { p_year: year, p_office: officeParam, p_status: statusParam, p_limit: 5 }),
            supabase.rpc('get_rep_leaderboard', { p_year: year, p_office: officeParam, p_status: statusParam })
        ]);

        setGrandTotalData(grandData || []);
        setDeptData(dData || []);
        setKpis(kpiData?.[0] || null);
        setTopClients(clientData || []);
        setLeaderboard(leaderData || []);
        setLoading(false);
    }, [year, selectedOffice, selectedStatus]);

    useEffect(() => {
        fetchData();
        const sub = supabase.channel('db-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, fetchData).subscribe();
        return () => { supabase.removeChannel(sub); };
    }, [fetchData]);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const statusOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous les devis' }, ...SALE_STATUSES], []);
    const deptOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous services' }, ...DEPARTMENTS.map(d => ({ value: d, label: d }))], []);
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="p-6 md:p-8 max-w-screen-2xl mx-auto space-y-8">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Tableau de Bord</h1>
                <p className="text-sm text-slate-400 mt-0.5">Performance et indicateurs clés de vente</p>
            </div>

            {/* Combined Filter Bar */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(val) => setYear(Number(val))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <Select value={selectedStatus} onChange={setSelectedStatus} options={statusOptions} className="w-40" />
                </FilterGroup>
                <FilterGroup label="Département">
                    <Select value={selectedDept} onChange={setSelectedDept} options={deptOptions} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={String(selectedMonth)} onChange={(val) => setSelectedMonth(val === 'Toutes' ? 'Toutes' : Number(val))} options={monthOptions} className="w-40" />
                </FilterGroup>
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
                    <p className="text-sm text-slate-400 font-medium">Analyse des données en cours...</p>
                </div>
            ) : (
                <>
                    {/* KPI Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <KPICard
                            title="Chiffre d'affaires YTD"
                            value={formatCurrencyCAD(kpis?.ytd_total || 0)}
                            subText={`${kpis?.ytd_count || 0} devis conclus`}
                            icon={TrendingUp}
                            trend={kpis?.pct_of_target}
                            trendLabel="de l'objectif"
                        />
                        <KPICard
                            title="Taille moyenne"
                            value={formatCurrencyCAD(kpis?.avg_deal_size || 0)}
                            subText="Par transaction"
                            icon={Briefcase}
                        />
                        <KPICard
                            title="Objectif Annuel"
                            value={formatCurrencyCAD(kpis?.annual_target || 0)}
                            subText="Planifié pour l'année"
                            icon={Target}
                        />
                        <KPICard
                            title="Répartition Statut"
                            value={formatCurrencyCAD(kpis?.invoiced_total || 0)}
                            subValue={formatCurrencyCAD(kpis?.accepted_total || 0)}
                            subText="Facturé vs Accepté"
                            icon={Users}
                            dual
                        />
                    </div>

                    {/* Detailed Insights Section */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Leaderboard */}
                        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                    <Trophy className="w-4 h-4 text-amber-500" /> Leaderboard Reps
                                </h3>
                            </div>
                            <div className="divide-y divide-slate-50">
                                {leaderboard.slice(0, 5).map((rep, idx) => (
                                    <div key={rep.rep_name} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center gap-3">
                                            <span className={cn(
                                                "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold",
                                                idx === 0 ? "bg-amber-100 text-amber-600" : "bg-slate-100 text-slate-400"
                                            )}>
                                                {idx + 1}
                                            </span>
                                            <div>
                                                <p className="text-sm font-semibold text-slate-700">{rep.rep_name}</p>
                                                <p className="text-[10px] text-slate-400 uppercase font-bold">{rep.office}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-slate-900">{formatCurrencyCAD(rep.total_amount)}</p>
                                            <p className="text-[10px] text-slate-400">{rep.deal_count} deals</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Top Clients */}
                        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-slate-100">
                                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                    <User className="w-4 h-4 text-blue-500" /> Top 5 Clients
                                </h3>
                            </div>
                            <div className="divide-y divide-slate-50">
                                {topClients.map((c) => (
                                    <div key={c.client_name} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                                        <div className="max-w-[200px]">
                                            <p className="text-sm font-semibold text-slate-700 truncate" title={c.client_name}>{c.client_name}</p>
                                            <p className="text-[10px] text-slate-400 uppercase font-bold">{c.office}</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-slate-900">{formatCurrencyCAD(c.total_amount)}</p>
                                            <p className="text-[10px] text-slate-400">{c.deal_count} devis</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Main Performance Table */}
                    <div className="space-y-6">
                        <SommaireTable
                            title={selectedDept === 'Toutes' ? "Performance Globale" : `Performance — ${selectedDept}`}
                            data={selectedDept === 'Toutes' ? grandTotalData : deptData.filter(x => x.department === selectedDept)}
                            year={year}
                            selectedMonth={selectedMonth}
                        />
                    </div>
                </>
            )}
        </div>
    );
}

function KPICard({ title, value, subValue, subText, icon: Icon, trend, trendLabel, dual }: any) {
    return (
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-card flex flex-col justify-between hover:shadow-card-hover transition-all group">
            <div className="flex items-start justify-between mb-4">
                <div className="p-2.5 bg-slate-50 rounded-xl text-slate-400 group-hover:text-brand-main group-hover:bg-amber-50 transition-colors">
                    <Icon className="w-5 h-5" />
                </div>
                {trend !== undefined && (
                    <div className={cn(
                        "text-[11px] font-bold px-2 py-0.5 rounded-full",
                        trend >= 100 ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
                    )}>
                        {trend}% {trendLabel}
                    </div>
                )}
            </div>
            <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">{title}</p>
                <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-slate-900">{value}</span>
                </div>
                {dual && subValue && (
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] font-bold">
                        <span className="text-emerald-500">I : {value}</span>
                        <span className="text-slate-300">|</span>
                        <span className="text-amber-500">A : {subValue}</span>
                    </div>
                )}
                <p className="text-[11px] text-slate-400 mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
