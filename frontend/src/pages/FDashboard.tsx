import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Loader2, TrendingUp, Target, Briefcase, Trophy, User, FileText, X, ChevronRight, MinusCircle } from 'lucide-react';
import type { SommaireRow } from '../types/database';
import { SommaireTable } from '../components/dashboard/SommaireTable';
import { DEPARTMENTS, MONTHS, OFFICES, INVOICE_STATUSES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { SyncButton } from '../components/SyncButton';

interface InvDashboardKPIs {
    ytd_total: number;
    ytd_count: number;
    avg_deal_size: number;
    annual_target: number;
    pct_of_target: number;
    paid_total: number;
    partial_total: number;
    avoir_total: number;
}

interface TopClient { client_name: string; total_amount: number; deal_count: number; office: string; }
interface LeaderboardEntry { rep_name: string; office: string; total_amount: number; deal_count: number; avg_deal: number; rank: number; }

export default function FDashboard() {
    const { isAdmin, repName: authRepName } = useAuth();

    const [year, setYear] = useState<number>(2026);
    const [selectedOffice, setSelectedOffice] = useState<string>('Toutes');
    const [selectedStatus, setSelectedStatus] = useState<string>('Toutes');
    const [selectedDept, setSelectedDept] = useState<string>('Toutes');
    const [selectedMonth, setSelectedMonth] = useState<number | 'Toutes'>('Toutes');
    // Admin can switch reps; members are locked to their own rep
    const [selectedRep, setSelectedRep] = useState<string>(isAdmin ? 'Tous' : (authRepName ?? 'Tous'));

    const [loading, setLoading] = useState(true);
    const [showLeaderboard, setShowLeaderboard] = useState(false);
    const [showClients, setShowClients] = useState(false);
    const [grandTotalData, setGrandTotalData] = useState<SommaireRow[]>([]);
    const [deptData, setDeptData] = useState<SommaireRow[]>([]);
    const [prevGrandTotalData, setPrevGrandTotalData] = useState<SommaireRow[]>([]);
    const [prevDeptData, setPrevDeptData] = useState<SommaireRow[]>([]);
    const [kpis, setKpis] = useState<InvDashboardKPIs | null>(null);
    const [topClients, setTopClients] = useState<TopClient[]>([]);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    const [allReps, setAllReps] = useState<string[]>([]);

    const repParam = isAdmin ? (selectedRep === 'Tous' ? null : selectedRep) : (authRepName ?? null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        const officeParam = selectedOffice === 'Toutes' ? null : selectedOffice;
        const statusParam = selectedStatus === 'Toutes' ? null : selectedStatus;
        const deptParam = selectedDept === 'Toutes' ? null : selectedDept;
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;

        const [
            { data: grandData },
            { data: dData },
            { data: prevGrandData },
            { data: prevDData },
            { data: kpiData },
            { data: clientData },
            { data: leaderData }
        ] = await Promise.all([
            supabase.rpc('get_inv_sommaire_grand_total', { p_year: year, p_office: officeParam, p_status: statusParam, p_rep: repParam }),
            supabase.rpc('get_inv_sommaire', { p_year: year, p_office: officeParam, p_status: statusParam, p_rep: repParam }),
            supabase.rpc('get_inv_sommaire_grand_total', { p_year: year - 1, p_office: officeParam, p_status: statusParam, p_rep: repParam }),
            supabase.rpc('get_inv_sommaire', { p_year: year - 1, p_office: officeParam, p_status: statusParam, p_rep: repParam }),
            supabase.rpc('get_inv_dashboard_kpis', { p_year: year, p_office: officeParam, p_status: statusParam, p_month: monthParam, p_dept: deptParam, p_rep: repParam }),
            supabase.rpc('get_inv_top_clients', { p_year: year, p_office: officeParam, p_status: statusParam, p_limit: 200, p_month: monthParam, p_dept: deptParam, p_rep: repParam }),
            supabase.rpc('get_inv_rep_leaderboard', { p_year: year, p_office: officeParam, p_status: statusParam, p_month: monthParam, p_dept: deptParam, p_rep: repParam })
        ]);

        setGrandTotalData(grandData || []);
        setDeptData(dData || []);
        setPrevGrandTotalData(prevGrandData || []);
        setPrevDeptData(prevDData || []);
        setKpis(kpiData?.[0] || null);
        setTopClients(clientData || []);
        const lb: LeaderboardEntry[] = leaderData || [];
        setLeaderboard(lb);
        if (isAdmin && allReps.length === 0 && lb.length > 0) {
            setAllReps(lb.map((r: LeaderboardEntry) => r.rep_name).sort());
        }
        setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [year, selectedOffice, selectedStatus, selectedDept, selectedMonth, repParam]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        const sub = supabase.channel('inv-db-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => fetchDataRef.current())
            .subscribe();
        return () => { supabase.removeChannel(sub); };
    }, []);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const statusOptions = useMemo(() => [{ value: 'Toutes', label: 'Payé + Partiel' }, ...INVOICE_STATUSES], []);
    const deptOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous services' }, ...DEPARTMENTS.map(d => ({ value: d, label: d }))], []);
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const repOptions = useMemo(() => [{ value: 'Tous', label: 'Toute l\'équipe' }, ...allReps.map(r => ({ value: r, label: r }))], [allReps]);
    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    return (
        <>
        <div className="p-6 md:p-8 max-w-screen-2xl mx-auto space-y-8">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
                        Factures — Tableau de Bord
                        {!isAdmin && authRepName && <span className="ml-2 text-base font-normal text-slate-400">({authRepName})</span>}
                    </h1>
                    <p className="text-sm text-slate-400 mt-0.5">Performance de facturation et indicateurs clés</p>
                </div>
                <SyncButton
                    functionName="zoho-invoice-sync"
                    logPattern="sync_invoices%"
                    onSyncComplete={() => fetchDataRef.current()}
                />
            </div>

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
                {isAdmin && (
                    <FilterGroup label="Représentant">
                        <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-44" />
                    </FilterGroup>
                )}
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
                    <p className="text-sm text-slate-400 font-medium">Analyse des factures en cours...</p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                        <KPICard title="Total Facturé YTD" value={formatCurrencyCAD(kpis?.ytd_total || 0)} subText="Revenus facturés cumulés" icon={TrendingUp} trend={kpis?.pct_of_target} trendLabel="de l'objectif" />
                        <KPICard title="Nb Factures" value={String(kpis?.ytd_count || 0)} subText="Factures (filtres actifs)" icon={FileText} />
                        <KPICard title="Montant Moyen" value={formatCurrencyCAD(kpis?.avg_deal_size || 0)} subText="Par facture" icon={Briefcase} />
                        <KPICard title="Objectif Annuel" value={formatCurrencyCAD(kpis?.annual_target || 0)} subText="Planifié pour l'année" icon={Target} />
                        <KPICard
                            title="Avoirs (Crédits)"
                            value={formatCurrencyCAD(kpis?.avoir_total || 0)}
                            subText={`Payé: ${formatCurrencyCAD(kpis?.paid_total || 0)} | Partiel: ${formatCurrencyCAD(kpis?.partial_total || 0)}`}
                            icon={MinusCircle}
                        />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Leaderboard */}
                        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                    <Trophy className="w-4 h-4 text-amber-500" /> Leaderboard Reps
                                </h3>
                                {leaderboard.length > 5 && (
                                    <button onClick={() => setShowLeaderboard(true)} className="flex items-center gap-1 text-[11px] font-bold text-brand-main hover:text-amber-600 transition-colors">
                                        Voir tout ({leaderboard.length}) <ChevronRight className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                            <div className="divide-y divide-slate-50">
                                {leaderboard.slice(0, 5).map((rep, idx) => (
                                    <div key={rep.rep_name} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center gap-3">
                                            <span className={cn("w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold", idx === 0 ? "bg-amber-100 text-amber-600" : "bg-slate-100 text-slate-400")}>{idx + 1}</span>
                                            <div>
                                                <p className="text-sm font-semibold text-slate-700">{rep.rep_name}</p>
                                                <p className="text-[10px] text-slate-400 uppercase font-bold">{rep.office}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-slate-900">{formatCurrencyCAD(rep.total_amount)}</p>
                                            <p className="text-sm font-bold text-slate-500 tabular-nums">{rep.deal_count} <span className="text-[10px] font-normal text-slate-400">factures</span></p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Top Clients */}
                        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                    <User className="w-4 h-4 text-blue-500" /> Top 5 Clients
                                </h3>
                                {topClients.length > 5 && (
                                    <button onClick={() => setShowClients(true)} className="flex items-center gap-1 text-[11px] font-bold text-brand-main hover:text-amber-600 transition-colors">
                                        Voir tout ({topClients.length}) <ChevronRight className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                            <div className="divide-y divide-slate-50">
                                {topClients.slice(0, 5).map((c) => (
                                    <div key={c.client_name} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                                        <div className="max-w-[200px]">
                                            <p className="text-sm font-semibold text-slate-700 truncate" title={c.client_name}>{c.client_name}</p>
                                            <p className="text-[10px] text-slate-400 uppercase font-bold">{c.office}</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-slate-900">{formatCurrencyCAD(c.total_amount)}</p>
                                            <p className="text-sm font-bold text-slate-500 tabular-nums">{c.deal_count} <span className="text-[10px] font-normal text-slate-400">factures</span></p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <SommaireTable
                            title={selectedDept === 'Toutes' ? "Performance Globale — Factures" : `Performance — ${selectedDept}`}
                            data={selectedDept === 'Toutes' ? grandTotalData : deptData.filter(x => x.department === selectedDept)}
                            prevYearData={selectedDept === 'Toutes' ? prevGrandTotalData : prevDeptData.filter(x => x.department === selectedDept)}
                            year={year}
                            selectedMonth={selectedMonth}
                            dealLabel="factures"
                        />
                    </div>
                </>
            )}
        </div>

        {showLeaderboard && (
            <Modal title="Leaderboard Reps — Factures" onClose={() => setShowLeaderboard(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">#</th>
                            <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Représentant</th>
                            <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Siège</th>
                            <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total</th>
                            <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Factures</th>
                            <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Moy./facture</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {leaderboard.map((rep, idx) => (
                            <tr key={rep.rep_name} className="hover:bg-slate-50/60 transition-colors">
                                <td className="px-4 py-2.5"><span className={cn("w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold", idx === 0 ? "bg-amber-100 text-amber-600" : idx === 1 ? "bg-slate-100 text-slate-500" : idx === 2 ? "bg-orange-50 text-orange-400" : "bg-slate-50 text-slate-300")}>{idx + 1}</span></td>
                                <td className="px-4 py-2.5 font-semibold text-slate-700">{rep.rep_name}</td>
                                <td className="px-4 py-2.5 text-[10px] font-bold text-slate-400 uppercase">{rep.office}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-slate-900 tabular-nums">{formatCurrencyCAD(rep.total_amount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-slate-500 tabular-nums">{rep.deal_count}</td>
                                <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums text-xs">{formatCurrencyCAD(rep.avg_deal)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Modal>
        )}

        {showClients && (
            <Modal title="Tous les clients — Factures" onClose={() => setShowClients(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">#</th>
                            <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Client</th>
                            <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Siège</th>
                            <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total</th>
                            <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Factures</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {topClients.map((c, idx) => (
                            <tr key={c.client_name} className="hover:bg-slate-50/60 transition-colors">
                                <td className="px-4 py-2.5 text-xs font-bold text-slate-300 tabular-nums">{idx + 1}</td>
                                <td className="px-4 py-2.5 font-semibold text-slate-700 max-w-[240px] truncate" title={c.client_name}>{c.client_name}</td>
                                <td className="px-4 py-2.5 text-[10px] font-bold text-slate-400 uppercase">{c.office}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-slate-900 tabular-nums">{formatCurrencyCAD(c.total_amount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-slate-500 tabular-nums">{c.deal_count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Modal>
        )}
        </>
    );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
                    <h3 className="text-sm font-bold text-slate-800">{title}</h3>
                    <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all"><X className="w-4 h-4" /></button>
                </div>
                <div className="overflow-y-auto">{children}</div>
            </div>
        </div>
    );
}

function KPICard({ title, value, subText, icon: Icon, trend, trendLabel }: { title: string; value: string; subText: string; icon: React.ElementType; trend?: number; trendLabel?: string }) {
    return (
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-card flex flex-col justify-between hover:shadow-card-hover transition-all group">
            <div className="flex items-start justify-between mb-4">
                <div className="p-2.5 bg-slate-50 rounded-xl text-slate-400 group-hover:text-brand-main group-hover:bg-amber-50 transition-colors">
                    <Icon className="w-5 h-5" />
                </div>
                {trend !== undefined && (
                    <div className={cn("text-[11px] font-bold px-2 py-0.5 rounded-full", trend >= 100 ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600")}>
                        {trend}% {trendLabel}
                    </div>
                )}
            </div>
            <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">{title}</p>
                <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
                <p className="text-[11px] text-slate-400 mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
