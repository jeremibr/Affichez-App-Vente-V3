import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Loader2, TrendingUp, Users, Percent, DollarSign } from 'lucide-react';
import type {
    ZohoLeadKPIs, ZohoLeadBreakdownRow, ZohoLeadFilterOptions,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { InfoHint } from '../components/InfoHint';
import { formatCurrencyCAD, cn } from '../lib/utils';

/**
 * Leads dashboard, over Zoho's Leads module.
 *
 * Reads zoho_leads (stage = 'lead'), not the legacy hand-entered `leads` table
 * this page used to query — that held 192 rows, all dated 2026-01-01, and had not
 * been updated since May. Contacts are deliberately out of scope: most were
 * created directly in Zoho as clients and were never leads, so including them put
 * conversion at ~99% and inflated revenue several-fold.
 */
export default function LeadsDashboard() {
    const [yearParam, _setYearParam] = useUrlState('year', '2026');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    const setYear = (v: number | 'Toutes') => _setYearParam(v === 'Toutes' ? 'Toutes' : String(v));
    const [selectedRep, setSelectedRep] = useUrlState('rep', 'Tous');
    const [selectedSource, setSelectedSource] = useUrlState('source', 'Toutes');
    const [selectedService, setSelectedService] = useUrlState('service', 'Tous');

    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<ZohoLeadKPIs | null>(null);
    const [byRep, setByRep] = useState<ZohoLeadBreakdownRow[]>([]);
    const [bySource, setBySource] = useState<ZohoLeadBreakdownRow[]>([]);
    const [byService, setByService] = useState<ZohoLeadBreakdownRow[]>([]);

    // Filter values come from the data, not a hardcoded list. The old constants
    // were the legacy table's six sources, of which only "Meta Ads" exists in
    // Zoho — the real top source, "Publicité/Recherche Google", was not offered.
    const [options, setOptions] = useState<ZohoLeadFilterOptions | null>(null);

    const yearParamValue = year === 'Toutes' ? null : year;

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
            supabase.rpc('get_zoho_lead_kpis', {
                p_year: yearParamValue, p_month: monthParam, p_rep: repParam,
                p_source: sourceParam, p_service: serviceParam,
            }),
            supabase.rpc('get_zoho_leads_by_rep', {
                p_year: yearParamValue, p_month: monthParam,
                p_source: sourceParam, p_service: serviceParam,
            }),
            supabase.rpc('get_zoho_leads_by_source', {
                p_year: yearParamValue, p_month: monthParam,
                p_rep: repParam, p_service: serviceParam,
            }),
            supabase.rpc('get_zoho_leads_by_service', {
                p_year: yearParamValue, p_month: monthParam,
                p_rep: repParam, p_source: sourceParam,
            }),
        ]);

        setKpis((kpiData as ZohoLeadKPIs[])?.[0] ?? null);
        setByRep((repData as ZohoLeadBreakdownRow[]) ?? []);
        setBySource((srcData as ZohoLeadBreakdownRow[]) ?? []);
        setByService((svcData as ZohoLeadBreakdownRow[]) ?? []);
        setLoading(false);
    }, [yearParamValue, selectedMonth, selectedRep, selectedSource, selectedService]);

    const fetchOptions = useCallback(async () => {
        const { data } = await supabase
            // p_stage: 'lead' because every figure on this page counts leads only.
            // Without it the dropdowns were built from leads AND contacts, so a rep
            // or source carried solely by contacts could be picked and returned an
            // all-zero dashboard — which reads as broken data, not an empty filter.
            .rpc('get_zoho_lead_filter_options', { p_year: yearParamValue, p_stage: 'lead' })
            .single<ZohoLeadFilterOptions>();
        if (data) setOptions(data);
    }, [yearParamValue]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    // Options load once per year change. The rule fires on any setState
    // reachable from an effect; the write happens in the awaited
    // continuation, not synchronously, so there is no cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // Coalesced: a full sync rewrites ~29k rows, and one refetch per change event
    // would fire thousands of queries at the browser.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = supabase
            .channel('leads-dashboard-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_leads' }, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => fetchDataRef.current(), 1500);
            })
            .subscribe();
        return () => {
            if (timer) clearTimeout(timer);
            supabase.removeChannel(sub);
        };
    }, []);

    const yearOptions = [
        { value: 'Toutes', label: 'Toutes les années' },
        ...[2027, 2026, 2025, 2024, 2023, 2022].map(y => ({ value: String(y), label: String(y) })),
    ];
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );
    const repOptions = useMemo(
        () => [{ value: 'Tous', label: 'Tous les reps' }, ...(options?.reps ?? []).map(r => ({ value: r, label: r }))],
        [options],
    );
    const sourceOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Toutes les sources' }, ...(options?.sources ?? []).map(s => ({ value: s, label: s }))],
        [options],
    );
    const serviceOptions = useMemo(
        () => [{ value: 'Tous', label: 'Tous les services' }, ...(options?.services ?? []).map(s => ({ value: s, label: s }))],
        [options],
    );

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Leads — Tableau de bord</h1>
                <p className="text-xs md:text-sm text-slate-400 mt-0.5">
                    Leads entrants du module Leads de Zoho CRM, et ce qu&rsquo;ils ont rapporté
                </p>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select
                        value={year === 'Toutes' ? 'Toutes' : String(year)}
                        onChange={v => setYear(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={yearOptions} variant="accent" className="w-40"
                    />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={String(selectedMonth)}
                        onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={monthOptions} className="w-40"
                    />
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
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        <KPICard
                            title="Leads reçus"
                            value={(kpis?.leads_received ?? 0).toLocaleString('fr-CA')}
                            subText="Module Leads de Zoho"
                            icon={Users}
                            hint="Nombre de leads créés dans Zoho CRM sur la période. Les contacts ne sont pas comptés : la plupart ont été créés directement comme clients et n'ont jamais été des leads."
                        />
                        <KPICard
                            title="Convertis"
                            value={(kpis?.leads_converted ?? 0).toLocaleString('fr-CA')}
                            subText={`${(kpis?.conversion_rate ?? 0).toFixed(1)} % des leads`}
                            icon={TrendingUp}
                            hint="Leads que Zoho a marqués comme convertis en contact/compte. Presque tous les leads finissent par l'être, donc ce taux bouge peu — regardez plutôt « Leads facturés »."
                        />
                        <KPICard
                            title="Leads facturés"
                            value={(kpis?.leads_invoiced ?? 0).toLocaleString('fr-CA')}
                            subText={`${(kpis?.invoiced_rate ?? 0).toFixed(1)} % des leads`}
                            icon={Percent}
                            highlight={(kpis?.invoiced_rate ?? 0) >= 20}
                            hint="Leads dont le compte a réellement été facturé après l'arrivée du lead. C'est la conversion qui compte : elle mesure de l'argent, pas une case cochée dans Zoho."
                        />
                        <KPICard
                            title="Revenus générés"
                            value={formatCurrencyCAD(kpis?.revenue_attributed ?? 0)}
                            subText={`Valeur client totale ${formatCurrencyCAD(kpis?.revenue_lifetime ?? 0)}`}
                            icon={DollarSign}
                            hint="Factures datées à partir de l'arrivée du lead : un lead ne peut pas avoir généré des revenus antérieurs à lui. La « valeur client totale » ajoute tout l'historique de facturation du compte, y compris avant le lead. Les deux sont comptés une seule fois par compte."
                        />
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-6">
                        <LeadsBreakdownTable title="Par représentant" rows={byRep} />
                        <LeadsBreakdownTable title="Par source" rows={bySource} />
                        <LeadsBreakdownTable
                            title="Par service"
                            rows={byService}
                            note="Un lead peut cocher plusieurs services : le total des lignes dépasse le nombre de leads."
                        />
                    </div>
                </>
            )}
        </div>
    );
}

function LeadsBreakdownTable({ title, rows, note }: {
    title: string;
    rows: ZohoLeadBreakdownRow[];
    note?: string;
}) {
    const totalLeads = rows.reduce((s, r) => s + r.nb_leads, 0);
    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-800">{title}</h3>
                {note && <InfoHint text={note} />}
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-400 text-center">Aucun lead</p>
            ) : (
                <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-slate-50/95 backdrop-blur">
                            <tr className="border-b border-slate-50">
                                <th className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Nom</th>
                                <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Leads</th>
                                <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Facturés</th>
                                <th className="px-4 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Revenus</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {rows.map(r => {
                                const pct = totalLeads > 0 ? Math.round((r.nb_leads / totalLeads) * 100) : 0;
                                const rate = r.nb_leads > 0 ? ((r.nb_invoiced / r.nb_leads) * 100).toFixed(0) : '0';
                                return (
                                    <tr key={r.label} className="hover:bg-slate-50/60 transition-colors">
                                        <td className="px-4 py-2.5">
                                            <p className="font-semibold text-slate-700 text-xs truncate max-w-[150px]" title={r.label}>
                                                {r.label}
                                            </p>
                                            <div className="mt-1 h-1 rounded-full bg-slate-100 w-full max-w-[100px]">
                                                <div className="h-1 rounded-full bg-brand-main" style={{ width: `${pct}%` }} />
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-bold text-slate-700 tabular-nums">{r.nb_leads}</td>
                                        <td className="px-4 py-2.5 text-right tabular-nums">
                                            <span className="font-bold text-slate-700">{r.nb_invoiced}</span>
                                            <span className={cn('ml-1 text-[10px] font-bold',
                                                Number(rate) >= 20 ? 'text-emerald-500' : 'text-slate-400')}>
                                                ({rate}%)
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-bold text-slate-900 tabular-nums text-xs">
                                            {formatCurrencyCAD(r.total_amount)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function KPICard({ title, value, subText, icon: Icon, highlight, hint }: {
    title: string;
    value: string;
    subText: string;
    icon: React.ElementType;
    highlight?: boolean;
    hint?: string;
}) {
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
