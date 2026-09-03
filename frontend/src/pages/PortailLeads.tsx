import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Loader2, TrendingUp, Users, Percent, DollarSign } from 'lucide-react';
import type { ZohoLeadKPIs, ZohoLeadsMonthlyRow, ZohoLeadFilterOptions } from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { InfoHint } from '../components/InfoHint';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import LeadsDetail from './LeadsDetail';

interface Props { propRepName?: string; }

export default function PortailLeads({ propRepName }: Props) {
    const { repName: authRepName } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const [tab, setTab] = useUrlState('tab', 'apercu') as ['apercu' | 'detail', (v: 'apercu' | 'detail') => void];
    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    const [selectedSource, setSelectedSource] = useUrlState('source', 'Toutes');
    const [selectedService, setSelectedService] = useUrlState('service', 'Tous');

    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<ZohoLeadKPIs | null>(null);
    const [monthly, setMonthly] = useState<ZohoLeadsMonthlyRow[]>([]);
    // Sources and services come from the data. The hardcoded lists were the
    // legacy table's, and only one of their six values exists in Zoho.
    const [options, setOptions] = useState<ZohoLeadFilterOptions | null>(null);

    const repParam = repName || null;

    const fetchData = useCallback(async () => {
        if (!repParam) return;
        setLoading(true);
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;
        const sourceParam = selectedSource === 'Toutes' ? null : selectedSource;
        const serviceParam = selectedService === 'Tous' ? null : selectedService;

        const [
            { data: kpiData },
            { data: monthData },
        ] = await Promise.all([
            supabase.rpc('get_zoho_lead_kpis', { p_year: year, p_month: monthParam, p_rep: repParam, p_source: sourceParam, p_service: serviceParam }),
            supabase.rpc('get_zoho_leads_monthly_summary', { p_year: year, p_rep: repParam, p_source: sourceParam, p_service: serviceParam }),
        ]);

        setKpis((kpiData as ZohoLeadKPIs[])?.[0] ?? null);
        setMonthly((monthData as ZohoLeadsMonthlyRow[]) ?? []);
        setLoading(false);
    }, [year, selectedMonth, selectedSource, selectedService, repParam]);

    const fetchOptions = useCallback(async () => {
        const { data } = await supabase
            // Lead-only, to match get_zoho_lead_kpis and the monthly summary above —
            // a source that only contacts carry would otherwise be offered here and
            // empty the whole portal.
            .rpc('get_zoho_lead_filter_options', { p_year: year, p_stage: 'lead' })
            .single<ZohoLeadFilterOptions>();
        if (data) setOptions(data);
    }, [year]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    // Options load once per year change. The rule fires on any setState
    // reachable from an effect; the write happens in the awaited
    // continuation, not synchronously, so there is no cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // Coalesced: a full sync rewrites ~29k rows, so one refetch per change event
    // would stampede the browser.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = supabase
            .channel(`portail-leads-${repName}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_leads' }, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => fetchDataRef.current(), 1500);
            })
            .subscribe();
        return () => {
            if (timer) clearTimeout(timer);
            supabase.removeChannel(sub);
        };
    }, [repName]);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const sourceOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Toutes sources' }, ...(options?.sources ?? []).map(s => ({ value: s, label: s }))],
        [options],
    );
    const serviceOptions = useMemo(
        () => [{ value: 'Tous', label: 'Tous services' }, ...(options?.services ?? []).map(s => ({ value: s, label: s }))],
        [options],
    );

    const monthLabel = (m: number) => MONTHS.find(mo => mo.value === m)?.label ?? String(m);

    if (!repName) {
        return (
            <div className="p-8 text-center text-slate-400 text-sm">
                Aucun représentant sélectionné.
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Mes Leads</h1>
                    <p className="text-xs md:text-sm text-slate-400 mt-0.5">{repName}</p>
                </div>
                {/* Tab switcher */}
                <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
                    <TabBtn active={tab === 'apercu'} onClick={() => setTab('apercu')}>Aperçu</TabBtn>
                    <TabBtn active={tab === 'detail'} onClick={() => setTab('detail')}>Détail</TabBtn>
                </div>
            </div>

            {tab === 'apercu' && (
                <>
                    <FilterBar>
                        <FilterGroup label="Année">
                            <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                        </FilterGroup>
                        <FilterGroup label="Mois">
                            <Select value={String(selectedMonth)} onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))} options={monthOptions} className="w-40" />
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
                            <p className="text-sm text-slate-400 font-medium">Chargement de vos leads...</p>
                        </div>
                    ) : (
                        <>
                            {/* KPI Cards */}
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                                <KPICard
                                    title="Leads reçus"
                                    value={(kpis?.leads_received ?? 0).toLocaleString('fr-CA')}
                                    subText="Module Leads de Zoho"
                                    icon={Users}
                                    hint="Vos leads créés dans Zoho CRM sur la période. Les contacts ne sont pas comptés : la plupart ont été créés directement comme clients."
                                />
                                <KPICard
                                    title="Convertis"
                                    value={(kpis?.leads_converted ?? 0).toLocaleString('fr-CA')}
                                    subText={`${(kpis?.conversion_rate ?? 0).toFixed(1)} % des leads`}
                                    icon={TrendingUp}
                                    hint="Leads que Zoho a marqués comme convertis en contact/compte. Presque tous finissent par l’être, donc ce taux bouge peu."
                                />
                                <KPICard
                                    title="Leads facturés"
                                    value={(kpis?.leads_invoiced ?? 0).toLocaleString('fr-CA')}
                                    subText={`${(kpis?.invoiced_rate ?? 0).toFixed(1)} % des leads`}
                                    icon={Percent}
                                    highlight={(kpis?.invoiced_rate ?? 0) >= 20}
                                    hint="Leads dont le compte a réellement été facturé après l’arrivée du lead. C’est la conversion qui compte."
                                />
                                <KPICard
                                    title="Revenus générés"
                                    value={formatCurrencyCAD(kpis?.revenue_attributed ?? 0)}
                                    subText={`Valeur client totale ${formatCurrencyCAD(kpis?.revenue_lifetime ?? 0)}`}
                                    icon={DollarSign}
                                    hint="Factures datées à partir de l’arrivée du lead — un lead ne peut pas avoir généré des revenus antérieurs à lui. La valeur client totale ajoute tout l’historique du compte. Compté une seule fois par compte."
                                />
                            </div>

                            {/* Monthly summary table */}
                            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                                <div className="px-5 py-4 border-b border-slate-100">
                                    <h3 className="text-sm font-bold text-slate-800">Résumé mensuel</h3>
                                </div>
                                {monthly.length === 0 ? (
                                    <p className="px-5 py-8 text-sm text-slate-400 text-center">Aucune donnée</p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-slate-50 bg-slate-50/60">
                                                    <th className="th text-left">Mois</th>
                                                    <th className="th text-right">Leads</th>
                                                    <th className="th text-right">Facturés</th>
                                                    <th className="th text-right">Taux</th>
                                                    <th className="th text-right">Revenus</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-50">
                                                {monthly.map(row => {
                                                    const rate = row.nb_leads > 0 ? ((row.nb_invoiced / row.nb_leads) * 100).toFixed(0) : '0';
                                                    return (
                                                        <tr key={row.month} className="hover:bg-slate-50/60 transition-colors">
                                                            <td className="td font-semibold text-slate-700">{monthLabel(row.month)}</td>
                                                            <td className="td text-right tabular-nums font-bold text-slate-700">{row.nb_leads}</td>
                                                            <td className="td text-right tabular-nums font-bold text-slate-700">{row.nb_invoiced}</td>
                                                            <td className="td text-right tabular-nums">
                                                                <span className={cn("text-xs font-bold", Number(rate) >= 20 ? "text-emerald-500" : "text-slate-400")}>
                                                                    {rate}%
                                                                </span>
                                                            </td>
                                                            <td className="td text-right tabular-nums font-bold text-slate-900 text-xs">
                                                                {row.total_amount > 0 ? formatCurrencyCAD(row.total_amount) : <span className="text-slate-300">—</span>}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                            <tfoot>
                                                <tr className="border-t border-slate-200 bg-slate-50/60">
                                                    <td className="td font-bold text-slate-800">Total</td>
                                                    <td className="td text-right tabular-nums font-bold text-slate-800">{kpis?.leads_received ?? 0}</td>
                                                    <td className="td text-right tabular-nums font-bold text-slate-800">{kpis?.leads_invoiced ?? 0}</td>
                                                    <td className="td text-right tabular-nums">
                                                        <span className={cn("text-xs font-bold", (kpis?.invoiced_rate ?? 0) >= 20 ? "text-emerald-500" : "text-slate-400")}>
                                                            {(kpis?.invoiced_rate ?? 0).toFixed(1)}%
                                                        </span>
                                                    </td>
                                                    <td className="td text-right tabular-nums font-bold text-slate-900 text-xs">{formatCurrencyCAD(kpis?.revenue_attributed ?? 0)}</td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </>
            )}

            {tab === 'detail' && (
                <LeadsDetail propRepName={repName} />
            )}
        </div>
    );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-bold transition-all",
                active ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}
        >
            {children}
        </button>
    );
}

function KPICard({ title, value, subText, icon: Icon, highlight, hint }: { title: string; value: string; subText: string; icon: React.ElementType; highlight?: boolean; hint?: string }) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-2xl border border-slate-100 shadow-card flex flex-col justify-between hover:shadow-card-hover transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className="p-2 md:p-2.5 bg-slate-50 rounded-xl text-slate-400 group-hover:text-brand-main group-hover:bg-amber-50 transition-colors">
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <div className="flex items-center gap-1.5">
                    {highlight && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Bon</span>
                    )}
                    {hint && <InfoHint text={hint} />}
                </div>
            </div>
            <div>
                <p className="text-[10px] md:text-xs font-semibold text-slate-400 uppercase tracking-widest leading-tight">{title}</p>
                <p className="mt-1 text-base md:text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
                <p className="text-[10px] md:text-[11px] text-slate-400 mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
