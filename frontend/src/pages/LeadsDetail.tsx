import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Loader2, Plus, ExternalLink, X, Save, Pencil, Trash2 } from 'lucide-react';
import type { LeadRow } from '../types/database';
import { LEAD_SOURCES, LEAD_SERVICES, LEAD_STATUSES, MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useRepList } from '../hooks/useRepList';
import { useAuth } from '../contexts/AuthContext';

const STATUS_COLORS: Record<string, string> = {
    active: 'bg-blue-50 text-blue-600',
    won:    'bg-emerald-50 text-emerald-600',
    lost:   'bg-red-50 text-red-500',
};

const STATUS_LABELS: Record<string, string> = {
    active: 'Actif',
    won:    'Vendu',
    lost:   'Perdu',
};

const SOURCE_LABELS: Record<string, string> = Object.fromEntries(LEAD_SOURCES.map(s => [s.value, s.label]));
const SERVICE_LABELS: Record<string, string> = Object.fromEntries(LEAD_SERVICES.map(s => [s.value, s.label]));

interface LeadFormData {
    lead_date: string;
    rep_name: string;
    source: string;
    service_interest: string;
    amount_sold: string;
    zoho_crm_url: string;
    notes: string;
    lead_status: 'active' | 'won' | 'lost';
}

const emptyForm = (): LeadFormData => ({
    lead_date: new Date().toISOString().split('T')[0],
    rep_name: '',
    source: '',
    service_interest: '',
    amount_sold: '0',
    zoho_crm_url: '',
    notes: '',
    lead_status: 'active',
});

export default function LeadsDetail({ propRepName }: { propRepName?: string }) {
    const { repName: authRepName } = useAuth();
    const repList = useRepList();

    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    const [selectedRep, setSelectedRep] = useUrlState('rep', 'Tous');
    const [selectedSource, setSelectedSource] = useUrlState('source', 'Toutes');
    const [selectedService, setSelectedService] = useUrlState('service', 'Tous');
    const [selectedStatus, setSelectedStatus] = useUrlState('statut', 'Tous');

    const [leads, setLeads] = useState<LeadRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [form, setForm] = useState<LeadFormData>(emptyForm());

    // Inline edit state for amount_sold and notes
    const [inlineEdit, setInlineEdit] = useState<{ id: string; field: 'amount_sold' | 'notes'; value: string } | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const effectiveRepName = propRepName ?? null;

    const fetchData = useCallback(async () => {
        setLoading(true);

        let query = supabase
            .from('leads')
            .select('*')
            .gte('lead_date', `${year}-01-01`)
            .lte('lead_date', `${year}-12-31`)
            .order('lead_date', { ascending: false });

        if (selectedMonth !== 'Toutes') {
            const pad = String(selectedMonth).padStart(2, '0');
            query = query
                .gte('lead_date', `${year}-${pad}-01`)
                .lte('lead_date', `${year}-${pad}-31`);
        }
        if (effectiveRepName) {
            query = query.eq('rep_name', effectiveRepName);
        } else if (selectedRep !== 'Tous') {
            query = query.eq('rep_name', selectedRep);
        }
        if (selectedSource !== 'Toutes') query = query.eq('source', selectedSource);
        if (selectedService !== 'Tous') query = query.eq('service_interest', selectedService);
        if (selectedStatus !== 'Tous') query = query.eq('lead_status', selectedStatus);

        const { data } = await query;
        setLeads(data ?? []);
        setLoading(false);
    }, [year, selectedMonth, selectedRep, selectedSource, selectedService, selectedStatus, effectiveRepName]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);

    useEffect(() => {
        const sub = supabase
            .channel('leads-detail-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => fetchDataRef.current())
            .subscribe();
        return () => { supabase.removeChannel(sub); };
    }, []);

    const openAddForm = () => {
        setEditingId(null);
        setForm({ ...emptyForm(), rep_name: effectiveRepName ?? authRepName ?? '' });
        setShowForm(true);
    };

    const openEditForm = (lead: LeadRow) => {
        setEditingId(lead.id);
        setForm({
            lead_date: lead.lead_date,
            rep_name: lead.rep_name,
            source: lead.source,
            service_interest: lead.service_interest ?? '',
            amount_sold: String(lead.amount_sold),
            zoho_crm_url: lead.zoho_crm_url ?? '',
            notes: lead.notes ?? '',
            lead_status: lead.lead_status,
        });
        setShowForm(true);
    };

    const handleSave = async () => {
        if (!form.rep_name || !form.source || !form.lead_date) return;
        setSaving(true);
        const payload = {
            lead_date: form.lead_date,
            rep_name: form.rep_name,
            source: form.source,
            service_interest: form.service_interest || null,
            amount_sold: parseFloat(form.amount_sold) || 0,
            zoho_crm_url: form.zoho_crm_url || null,
            notes: form.notes || null,
            lead_status: form.lead_status,
        };

        if (editingId) {
            await supabase.from('leads').update(payload).eq('id', editingId);
        } else {
            await supabase.from('leads').insert(payload);
        }
        setSaving(false);
        setShowForm(false);
        fetchData();
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Supprimer ce lead ?')) return;
        await supabase.from('leads').delete().eq('id', id);
        fetchData();
    };

    const handleInlineChange = (id: string, field: 'amount_sold' | 'notes', value: string) => {
        setInlineEdit({ id, field, value });
        setLeads(prev => prev.map(l => l.id === id ? { ...l, [field]: field === 'amount_sold' ? parseFloat(value) || 0 : value } : l));
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            await supabase.from('leads').update({ [field]: field === 'amount_sold' ? parseFloat(value) || 0 : value }).eq('id', id);
            setInlineEdit(null);
        }, 600);
    };

    useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous les mois' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const repOptions = useMemo(() => [{ value: 'Tous', label: 'Tous les reps' }, ...repList.map(r => ({ value: r, label: r }))], [repList]);
    const sourceOptions = useMemo(() => [{ value: 'Toutes', label: 'Toutes sources' }, ...LEAD_SOURCES.map(s => ({ value: s.value, label: s.label }))], []);
    const serviceOptions = useMemo(() => [{ value: 'Tous', label: 'Tous services' }, ...LEAD_SERVICES.map(s => ({ value: s.value, label: s.label }))], []);
    const statusOptions = useMemo(() => [{ value: 'Tous', label: 'Tous statuts' }, ...LEAD_STATUSES.map(s => ({ value: s.value, label: s.label }))], []);

    const repFormOptions = useMemo(() => repList.map(r => ({ value: r, label: r })), [repList]);
    const sourceFormOptions = useMemo(() => LEAD_SOURCES.map(s => ({ value: s.value, label: s.label })), []);
    const serviceFormOptions = useMemo(() => [{ value: '', label: 'Non spécifié' }, ...LEAD_SERVICES.map(s => ({ value: s.value, label: s.label }))], []);
    const statusFormOptions = useMemo(() => LEAD_STATUSES.map(s => ({ value: s.value, label: s.label })), []);

    const totalAmount = leads.reduce((s, l) => s + l.amount_sold, 0);
    const wonCount = leads.filter(l => l.lead_status === 'won').length;

    return (
        <>
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">
                        {effectiveRepName ? `Leads — ${effectiveRepName}` : 'Leads — Détail'}
                    </h1>
                    <p className="text-xs md:text-sm text-slate-400 mt-0.5">Liste complète des leads avec détails</p>
                </div>
                <button
                    onClick={openAddForm}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-main text-white text-sm font-bold hover:bg-amber-600 transition-colors shadow-sm"
                >
                    <Plus className="w-4 h-4" /> Ajouter
                </button>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={String(selectedMonth)} onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))} options={monthOptions} className="w-40" />
                </FilterGroup>
                {!effectiveRepName && (
                    <FilterGroup label="Représentant">
                        <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-44" />
                    </FilterGroup>
                )}
                <FilterGroup label="Source">
                    <Select value={selectedSource} onChange={setSelectedSource} options={sourceOptions} className="w-52" />
                </FilterGroup>
                <FilterGroup label="Service">
                    <Select value={selectedService} onChange={setSelectedService} options={serviceOptions} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <Select value={selectedStatus} onChange={setSelectedStatus} options={statusOptions} className="w-36" />
                </FilterGroup>
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
                    <p className="text-sm text-slate-400 font-medium">Chargement des leads...</p>
                </div>
            ) : (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <span className="text-sm font-bold text-slate-800">{leads.length} leads</span>
                            <span className="text-[11px] text-slate-400">{wonCount} vendus · {formatCurrencyCAD(totalAmount)}</span>
                        </div>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[800px]">
                            <thead>
                                <tr className="border-b border-slate-50 bg-slate-50/60">
                                    <th className="th text-left">Date</th>
                                    {!effectiveRepName && <th className="th text-left">Rep</th>}
                                    <th className="th text-left">Source</th>
                                    <th className="th text-left">Service</th>
                                    <th className="th text-center">Statut</th>
                                    <th className="th text-right">Montant vendu</th>
                                    <th className="th text-left">Notes</th>
                                    <th className="th text-center">CRM</th>
                                    <th className="th text-center">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {leads.length === 0 && (
                                    <tr>
                                        <td colSpan={effectiveRepName ? 8 : 9} className="px-5 py-10 text-center text-sm text-slate-400">
                                            Aucun lead trouvé
                                        </td>
                                    </tr>
                                )}
                                {leads.map(lead => (
                                    <tr key={lead.id} className="hover:bg-slate-50/60 transition-colors">
                                        <td className="td tabular-nums text-slate-500 text-xs whitespace-nowrap">
                                            {new Date(lead.lead_date).toLocaleDateString('fr-CA')}
                                        </td>
                                        {!effectiveRepName && (
                                            <td className="td font-semibold text-slate-700">{lead.rep_name}</td>
                                        )}
                                        <td className="td text-xs text-slate-600 max-w-[160px]">
                                            <span className="truncate block" title={lead.source}>{SOURCE_LABELS[lead.source] ?? lead.source}</span>
                                        </td>
                                        <td className="td text-xs text-slate-500">
                                            {lead.service_interest ? (SERVICE_LABELS[lead.service_interest] ?? lead.service_interest) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="td text-center">
                                            <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold uppercase', STATUS_COLORS[lead.lead_status])}>
                                                {STATUS_LABELS[lead.lead_status]}
                                            </span>
                                        </td>
                                        <td className="td text-right tabular-nums">
                                            <input
                                                type="number"
                                                className={cn(
                                                    "w-28 text-right text-sm font-bold tabular-nums bg-transparent border-b border-transparent focus:border-brand-main focus:outline-none transition-colors",
                                                    lead.amount_sold > 0 ? "text-emerald-600" : "text-slate-400"
                                                )}
                                                value={inlineEdit?.id === lead.id && inlineEdit.field === 'amount_sold' ? inlineEdit.value : lead.amount_sold}
                                                onChange={e => handleInlineChange(lead.id, 'amount_sold', e.target.value)}
                                            />
                                        </td>
                                        <td className="td text-xs text-slate-500 max-w-[180px]">
                                            <input
                                                type="text"
                                                className="w-full text-xs bg-transparent border-b border-transparent focus:border-brand-main focus:outline-none transition-colors text-slate-500 placeholder:text-slate-300"
                                                placeholder="Ajouter une note..."
                                                value={inlineEdit?.id === lead.id && inlineEdit.field === 'notes' ? inlineEdit.value : (lead.notes ?? '')}
                                                onChange={e => handleInlineChange(lead.id, 'notes', e.target.value)}
                                            />
                                        </td>
                                        <td className="td text-center">
                                            {lead.zoho_crm_url ? (
                                                <a
                                                    href={lead.zoho_crm_url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-brand-main hover:bg-amber-50 transition-colors"
                                                    title="Ouvrir dans Zoho CRM"
                                                >
                                                    <ExternalLink className="w-3.5 h-3.5" />
                                                </a>
                                            ) : (
                                                <span className="text-slate-200">—</span>
                                            )}
                                        </td>
                                        <td className="td text-center">
                                            <div className="flex items-center justify-center gap-1">
                                                <button
                                                    onClick={() => openEditForm(lead)}
                                                    className="p-1.5 rounded-lg text-slate-400 hover:text-brand-main hover:bg-amber-50 transition-colors"
                                                    title="Modifier"
                                                >
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(lead.id)}
                                                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                                    title="Supprimer"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>

        {/* Add / Edit modal */}
        {showForm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
                <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
                <div
                    className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
                    onClick={e => e.stopPropagation()}
                >
                    <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
                        <h3 className="text-sm font-bold text-slate-800">{editingId ? 'Modifier le lead' : 'Ajouter un lead'}</h3>
                        <button onClick={() => setShowForm(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="overflow-y-auto p-5 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            <FormField label="Date *">
                                <input
                                    type="date"
                                    className="form-input"
                                    value={form.lead_date}
                                    onChange={e => setForm(f => ({ ...f, lead_date: e.target.value }))}
                                />
                            </FormField>
                            <FormField label="Statut">
                                <Select value={form.lead_status} onChange={v => setForm(f => ({ ...f, lead_status: v as 'active' | 'won' | 'lost' }))} options={statusFormOptions} className="w-full" />
                            </FormField>
                        </div>

                        <FormField label="Représentant *">
                            {effectiveRepName ? (
                                <p className="text-sm font-semibold text-slate-700 py-2">{effectiveRepName}</p>
                            ) : (
                                <Select value={form.rep_name} onChange={v => setForm(f => ({ ...f, rep_name: v }))} options={[{ value: '', label: 'Choisir un rep...' }, ...repFormOptions]} className="w-full" />
                            )}
                        </FormField>

                        <FormField label="Source *">
                            <Select value={form.source} onChange={v => setForm(f => ({ ...f, source: v }))} options={[{ value: '', label: 'Choisir une source...' }, ...sourceFormOptions]} className="w-full" />
                        </FormField>

                        <FormField label="Service d'intérêt">
                            <Select value={form.service_interest} onChange={v => setForm(f => ({ ...f, service_interest: v }))} options={serviceFormOptions} className="w-full" />
                        </FormField>

                        <FormField label="Montant vendu (CAD)">
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                className="form-input"
                                value={form.amount_sold}
                                onChange={e => setForm(f => ({ ...f, amount_sold: e.target.value }))}
                            />
                        </FormField>

                        <FormField label="Lien CRM Zoho">
                            <input
                                type="url"
                                className="form-input"
                                placeholder="https://crm.zoho.com/..."
                                value={form.zoho_crm_url}
                                onChange={e => setForm(f => ({ ...f, zoho_crm_url: e.target.value }))}
                            />
                        </FormField>

                        <FormField label="Notes">
                            <textarea
                                rows={3}
                                className="form-input resize-none"
                                placeholder="Informations complémentaires..."
                                value={form.notes}
                                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                            />
                        </FormField>
                    </div>
                    <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-3 flex-shrink-0">
                        <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100 transition-colors">
                            Annuler
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving || !form.rep_name || !form.source || !form.lead_date}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-main text-white text-sm font-bold hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {editingId ? 'Enregistrer' : 'Ajouter'}
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">{label}</label>
            {children}
        </div>
    );
}
