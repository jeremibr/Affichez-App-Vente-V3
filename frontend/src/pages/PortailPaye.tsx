import { useState, useEffect, useCallback, useRef } from 'react';
import { useUrlStateNumber } from '../hooks/useUrlState';
import { Wallet, Trash2, Loader2, Plus, User, Pencil, Check, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { fetchCommRate } from '../utils/commRates';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PayEntry {
    id: string;
    rep_name: string;
    year: number;
    pay_date: string;
    base_salary: number | null;
    commission: number | null;
    expenses: number | null;
    holidays: number | null;
    vacation: number | null;
    note: string;
    sort_order: number;
}

interface PayMeta {
    previous_year_balance: number;
    annual_bonus: number;
    commission_prev_year: number;
    bank_balance: number;
}

const EMPTY_META: PayMeta = {
    previous_year_balance: 0,
    annual_bonus: 0,
    commission_prev_year: 0,
    bank_balance: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function n(v: number | null | undefined): number { return v ?? 0; }

function fmt(v: number | null): string {
    if (v === null || v === undefined || v === 0) return '';
    return v.toFixed(2);
}

function formatPayDate(d: string): string {
    if (!d) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const [y, m, day] = d.split('-').map(Number);
        return new Date(y, m - 1, day).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    return d;
}

// ─── Schedule generator ───────────────────────────────────────────────────────

function generateBiweeklyDates(startDate: string, year: number): string[] {
    if (!startDate) return [];
    const dates: string[] = [];
    const d = new Date(startDate + 'T12:00:00');
    if (isNaN(d.getTime())) return [];
    while (d.getFullYear() <= year) {
        if (d.getFullYear() === year) {
            dates.push(d.toISOString().slice(0, 10));
        }
        d.setDate(d.getDate() + 14);
    }
    return dates;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props { propRepName?: string; embedded?: boolean; }

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortailPaye({ propRepName, embedded }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const canEdit = isAdmin && !viewAsRep;
    const isAdminView = !!propRepName;

    const [year, setYear]         = useUrlStateNumber('year', 2026);
    const [loading, setLoading]   = useState(true);
    const [entries, setEntries]   = useState<PayEntry[]>([]);
    const [meta, setMeta]         = useState<PayMeta>(EMPTY_META);
    const [commRate, setCommRate] = useState(0.05);
    const [invoiceTotal, setInvoiceTotal] = useState(0);
    const [generating, setGenerating] = useState(false);

    // Inline commission rate editing
    const [editingRate, setEditingRate] = useState(false);
    const [rateDraft, setRateDraft]     = useState('');

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    // ─── Fetch ───────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);
        const [entriesRes, metaRes, rate, invRes] = await Promise.all([
            supabase
                .from('paye_entries')
                .select('*')
                .eq('rep_name', repName)
                .eq('year', year)
                .order('sort_order', { ascending: true }),
            supabase
                .from('paye_meta')
                .select('*')
                .eq('rep_name', repName)
                .eq('year', year)
                .single(),
            fetchCommRate(repName),
            supabase
                .from('invoices')
                .select('amount')
                .eq('rep_name', repName)
                .gte('invoice_date', `${year}-01-01`)
                .lte('invoice_date', `${year}-12-31`)
                .neq('status', 'void'),
        ]);
        setEntries((entriesRes.data ?? []) as PayEntry[]);
        setMeta((metaRes.data as PayMeta | null) ?? EMPTY_META);
        setCommRate(rate);
        const invSum = (invRes.data ?? []).reduce(
            (s: number, r: { amount: number | string }) => s + Number(r.amount ?? 0), 0
        );
        setInvoiceTotal(invSum);
        setLoading(false);
    }, [repName, year]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── Auto-generate bi-weekly dates for admin view when year is empty ──────

    useEffect(() => {
        if (!isAdminView || !canEdit || loading || entries.length > 0 || !repName || generating) return;
        const defaultStart = `${year}-01-09`;
        const dates = generateBiweeklyDates(defaultStart, year);
        if (dates.length === 0) return;
        setGenerating(true);
        const rows = dates.map((pay_date, i) => ({ rep_name: repName, year, pay_date, sort_order: i }));
        supabase.from('paye_entries').insert(rows).select().then(({ data }) => {
            if (data) setEntries((data as PayEntry[]).sort((a, b) => a.pay_date < b.pay_date ? -1 : 1));
            setGenerating(false);
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, entries.length, isAdminView, canEdit, repName, year]);

    // In admin view, always show full year (no month filter)
    const filteredEntries = entries;

    // ─── Entry mutations (admin only) ────────────────────────────────────────


    const addEntry = async () => {
        if (!repName || !canEdit) return;
        const sort_order = entries.length;
        const { data } = await supabase
            .from('paye_entries')
            .insert({ rep_name: repName, year, sort_order })
            .select()
            .single();
        if (data) setEntries(prev => [...prev, data as PayEntry]);
    };

    const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

    const updateField = (id: string, field: keyof PayEntry, raw: string) => {
        if (!canEdit) return;
        const numericFields: (keyof PayEntry)[] = ['base_salary', 'commission', 'expenses', 'holidays', 'vacation'];
        const value = numericFields.includes(field)
            ? (raw === '' ? null : parseFloat(raw.replace(/[$,\s]/g, '').replace(',', '.')) || null)
            : raw;

        setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));

        clearTimeout(saveTimers.current[id + field]);
        saveTimers.current[id + field] = setTimeout(async () => {
            await supabase
                .from('paye_entries')
                .update({ [field]: value, updated_at: new Date().toISOString() })
                .eq('id', id);
        }, 600);
    };

    const deleteEntry = async (id: string) => {
        if (!canEdit) return;
        setEntries(prev => prev.filter(e => e.id !== id));
        await supabase.from('paye_entries').delete().eq('id', id);
    };

    // ─── Meta mutations (admin only) ──────────────────────────────────────────

    const metaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const updateMeta = (field: keyof PayMeta, raw: string) => {
        if (!canEdit) return;
        const value = raw === '' ? 0 : parseFloat(raw.replace(/[$,\s]/g, '').replace(',', '.')) || 0;
        setMeta(prev => ({ ...prev, [field]: value }));

        clearTimeout(metaTimer.current);
        metaTimer.current = setTimeout(async () => {
            await supabase
                .from('paye_meta')
                .upsert(
                    { rep_name: repName, year, [field]: value, updated_at: new Date().toISOString() },
                    { onConflict: 'rep_name,year' }
                );
        }, 600);
    };

    // ─── Totals (based on filtered entries for display, all entries for net) ──

    const totals = filteredEntries.reduce(
        (acc, e) => ({
            base_salary: acc.base_salary + n(e.base_salary),
            commission:  acc.commission  + n(e.commission),
            expenses:    acc.expenses    + n(e.expenses),
            holidays:    acc.holidays    + n(e.holidays),
            vacation:    acc.vacation    + n(e.vacation),
        }),
        { base_salary: 0, commission: 0, expenses: 0, holidays: 0, vacation: 0 }
    );
    const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);

    const commissionFacturees = invoiceTotal * commRate;
    const bankBalance         = n(meta.previous_year_balance) + commissionFacturees - totals.commission;

    const netTotal = grandTotal + n(meta.previous_year_balance) + n(meta.annual_bonus);

    // ─── Guard ────────────────────────────────────────────────────────────────

    if (!repName && !isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-2xl mx-auto flex items-center justify-center min-h-[60vh]">
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto">
                        <User className="w-7 h-7 text-slate-300" />
                    </div>
                    <h2 className="text-base font-semibold text-slate-700">Portail non configuré</h2>
                    <p className="text-sm text-slate-400 max-w-xs">Votre compte n'est pas encore associé à un représentant. Contactez un administrateur pour configurer votre accès.</p>
                </div>
            </div>
        );
    }

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className={cn(
            "space-y-5 md:space-y-6",
            !embedded && "p-4 md:p-8 max-w-screen-2xl mx-auto"
        )}>

            {/* Header */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                        <Wallet className="w-5 h-5 text-emerald-500" />
                        {isAdminView ? `Paye de ${repName}` : 'Ma Paye'}
                    </h2>
                    {!isAdminView && (
                        <p className="text-sm text-slate-400 mt-0.5">
                            {repName || 'Représentant'}
                            {!canEdit && <span className="ml-2 text-[10px] font-bold text-slate-300 uppercase tracking-widest">Lecture seule</span>}
                        </p>
                    )}
                </div>
            </div>

            {/* Filters — year only */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
            </FilterBar>

            {/* ─── Meta cards ──────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetaCard label="Solde Année Précédente"            value={meta.previous_year_balance} onChange={v => updateMeta('previous_year_balance', v)} bg="bg-blue-50 border-blue-100"           text="text-blue-700"    readOnly={!canEdit} />
                <MetaCard label="Bonus Annuel"                       value={meta.annual_bonus}          onChange={v => updateMeta('annual_bonus', v)}          bg="bg-brand-main/5 border-brand-main/20" text="text-brand-main"  readOnly={!canEdit} />
                <MetaCard label={`Commission ${year} Facturées`}     value={commissionFacturees}                                                                bg="bg-amber-50 border-amber-100"          text="text-amber-700"   readOnly />
                <MetaCard label="Montant en Banque"                  value={bankBalance}                                                                        bg="bg-emerald-50 border-emerald-100"      text="text-emerald-700" readOnly />
            </div>

            {/* ─── Payroll table ───────────────────────────────────────────── */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-4 flex-wrap">
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">Détail des paies — {year}</h3>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-slate-400">Taux commission :</span>
                            {canEdit && editingRate ? (
                                <div className="flex items-center gap-1.5">
                                    <input
                                        autoFocus
                                        type="number"
                                        min={0} max={100}
                                        value={rateDraft}
                                        onChange={e => setRateDraft(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                const n = parseFloat(rateDraft);
                                                if (!isNaN(n)) {
                                                    const r = n / 100;
                                                    import('../utils/commRates').then(m => m.saveCommRate(repName, r));
                                                    setCommRate(r);
                                                }
                                                setEditingRate(false);
                                            }
                                            if (e.key === 'Escape') setEditingRate(false);
                                        }}
                                        className="w-14 px-1.5 py-0.5 text-xs border border-brand-main rounded-md focus:outline-none text-center font-bold text-brand-main"
                                    />
                                    <span className="text-xs text-slate-400">%</span>
                                    <button
                                        onClick={() => {
                                            const n = parseFloat(rateDraft);
                                            if (!isNaN(n)) {
                                                const r = n / 100;
                                                import('../utils/commRates').then(m => m.saveCommRate(repName, r));
                                                setCommRate(r);
                                            }
                                            setEditingRate(false);
                                        }}
                                        className="p-0.5 text-emerald-500 hover:text-emerald-600"
                                    ><Check className="w-3 h-3" /></button>
                                    <button onClick={() => setEditingRate(false)} className="p-0.5 text-slate-300 hover:text-slate-500">
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            ) : canEdit ? (
                                <button
                                    onClick={() => { setRateDraft(String(Math.round(commRate * 100))); setEditingRate(true); }}
                                    className="flex items-center gap-1 group"
                                >
                                    <span className="text-xs font-bold text-brand-main tabular-nums">{Math.round(commRate * 100)}%</span>
                                    <Pencil className="w-2.5 h-2.5 text-slate-300 group-hover:text-brand-main transition-colors" />
                                </button>
                            ) : (
                                <span className="text-xs font-bold text-brand-main tabular-nums">{Math.round(commRate * 100)}%</span>
                            )}
                        </div>
                    </div>
                    {generating && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Génération du calendrier...
                        </div>
                    )}
                </div>

                {!repName ? (
                    <div className="flex items-center justify-center py-16">
                        <p className="text-sm text-slate-400">Sélectionnez un représentant ci-dessus</p>
                    </div>
                ) : loading ? (
                    <div className="flex items-center justify-center py-16 gap-2">
                        <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
                        <span className="text-sm text-slate-400">Chargement...</span>
                    </div>
                ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr className="bg-slate-100 border-b-2 border-slate-300">
                                <Th align="left"  color="text-slate-600" className="min-w-[160px]">Date</Th>
                                <Th align="right" color="text-blue-600">Salaire de base</Th>
                                <Th align="right" color="text-brand-main">Commission</Th>
                                <Th align="right" color="text-emerald-600">Remb. Dépenses</Th>
                                <Th align="right" color="text-purple-600">Fériés</Th>
                                <Th align="right" color="text-teal-600">Vacances</Th>
                                <Th align="right" color="text-slate-700">Total</Th>
                                <Th align="left"  color="text-slate-500" className="min-w-[130px]">Note</Th>
                                {canEdit && <th className="w-8 border-l border-slate-200" />}
                            </tr>
                        </thead>

                        <tbody>
                            {filteredEntries.length === 0 && (
                                <tr>
                                    <td colSpan={canEdit ? 9 : 8} className="px-5 py-12 text-center text-sm text-slate-300 italic">
                                        {false
                                            ? `Aucune paie pour ce mois`
                                            : `Aucune paie enregistrée pour ${year}`}
                                    </td>
                                </tr>
                            )}
                            {filteredEntries.map((entry) => {
                                const rowTotal = n(entry.base_salary) + n(entry.commission) + n(entry.expenses) + n(entry.holidays) + n(entry.vacation);
                                const dateVal = /^\d{4}-\d{2}-\d{2}$/.test(entry.pay_date) ? entry.pay_date : '';
                                return (
                                    <tr key={entry.id} className="border-b border-slate-200 hover:bg-amber-50/30 transition-colors group">
                                        {/* Date */}
                                        <td className="px-3 py-2 border-r border-slate-200">
                                            {canEdit ? (
                                                <input
                                                    type="date"
                                                    value={dateVal}
                                                    onChange={e => updateField(entry.id, 'pay_date', e.target.value)}
                                                    className="w-full bg-transparent text-slate-700 font-medium focus:outline-none text-sm cursor-pointer"
                                                />
                                            ) : (
                                                <span className="text-slate-700 font-medium text-sm">{formatPayDate(entry.pay_date) || '—'}</span>
                                            )}
                                        </td>

                                        {canEdit ? (
                                            <>
                                                <NumInput value={fmt(entry.base_salary)} onChange={v => updateField(entry.id, 'base_salary', v)} color="text-blue-700" />
                                                <NumInput value={fmt(entry.commission)}  onChange={v => updateField(entry.id, 'commission', v)}  color="text-brand-main" />
                                                <NumInput value={fmt(entry.expenses)}    onChange={v => updateField(entry.id, 'expenses', v)}    color="text-emerald-600" />
                                                <NumInput value={fmt(entry.holidays)}    onChange={v => updateField(entry.id, 'holidays', v)}    color="text-purple-600" />
                                                <NumInput value={fmt(entry.vacation)}    onChange={v => updateField(entry.id, 'vacation', v)}    color="text-teal-600" />
                                            </>
                                        ) : (
                                            <>
                                                <NumDisplay value={entry.base_salary} color="text-blue-700" />
                                                <NumDisplay value={entry.commission}  color="text-brand-main" />
                                                <NumDisplay value={entry.expenses}    color="text-emerald-600" />
                                                <NumDisplay value={entry.holidays}    color="text-purple-600" />
                                                <NumDisplay value={entry.vacation}    color="text-teal-600" />
                                            </>
                                        )}

                                        {/* Row total */}
                                        <td className="px-3 py-2 text-right font-bold text-slate-800 tabular-nums border-r border-slate-200">
                                            {rowTotal > 0 ? formatCurrencyCAD(rowTotal) : <span className="text-slate-200">—</span>}
                                        </td>

                                        {/* Note */}
                                        <td className="px-3 py-2 border-r border-slate-200">
                                            {canEdit ? (
                                                <input
                                                    type="text"
                                                    value={entry.note}
                                                    onChange={e => updateField(entry.id, 'note', e.target.value)}
                                                    placeholder="Note..."
                                                    className="w-full bg-transparent text-xs text-slate-400 placeholder:text-slate-200 focus:outline-none italic"
                                                />
                                            ) : (
                                                <span className="text-xs text-slate-400 italic">{entry.note || ''}</span>
                                            )}
                                        </td>

                                        {canEdit && (
                                            <td className="px-2 py-2">
                                                <button
                                                    onClick={() => deleteEntry(entry.id)}
                                                    className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-slate-300 hover:text-red-400 hover:bg-red-50 transition-all"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </td>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>

                        <tfoot>
                            {/* Add row — admin only */}
                            {canEdit && (
                                <tr className="border-t border-slate-200 bg-white">
                                    <td colSpan={9} className="px-4 py-2">
                                        <button
                                            onClick={addEntry}
                                            className="flex items-center gap-1.5 text-xs text-slate-300 hover:text-brand-main transition-colors font-medium"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                            Nouvelle ligne
                                        </button>
                                    </td>
                                </tr>
                            )}
                            {/* Totals */}
                            <tr className="border-t-2 border-slate-300 bg-slate-100">
                                <td className="px-3 py-3 text-xs font-bold text-slate-600 uppercase tracking-widest border-r border-slate-200">
                                    {`Total ${year}`}
                                </td>
                                <TotalCell value={totals.base_salary} color="text-blue-700" />
                                <TotalCell value={totals.commission}  color="text-brand-main" />
                                <TotalCell value={totals.expenses}    color="text-emerald-600" />
                                <TotalCell value={totals.holidays}    color="text-purple-600" />
                                <TotalCell value={totals.vacation}    color="text-teal-600" />
                                <td className="px-3 py-3 text-right font-bold text-slate-900 tabular-nums text-base border-r border-slate-200">
                                    {formatCurrencyCAD(grandTotal)}
                                </td>
                                <td colSpan={canEdit ? 2 : 1} />
                            </tr>
                        </tfoot>
                    </table>
                </div>
                )}
            </div>

            {/* ─── Net total banner ────────────────────────────────────────── */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-card px-4 md:px-6 py-4 md:py-5 flex items-center justify-between flex-wrap gap-4">
                <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Total Net — {year}</p>
                    <p className="text-2xl md:text-3xl font-bold text-slate-900 mt-1 tabular-nums">{formatCurrencyCAD(netTotal)}</p>
                    <p className="text-xs text-slate-400 mt-1">
                        Paies{n(meta.previous_year_balance) !== 0 ? ` + Solde ${year - 1}` : ''}{n(meta.annual_bonus) !== 0 ? ' + Bonus' : ''}
                    </p>
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-right">
                    <p className="text-xs text-slate-400">Total des paies</p>
                    <p className="text-sm font-bold text-slate-700 tabular-nums">{formatCurrencyCAD(grandTotal)}</p>
                    {n(meta.previous_year_balance) !== 0 && (<>
                        <p className="text-xs text-slate-400">Solde {year - 1}</p>
                        <p className="text-sm font-bold text-blue-600 tabular-nums">{formatCurrencyCAD(n(meta.previous_year_balance))}</p>
                    </>)}
                    {n(meta.annual_bonus) !== 0 && (<>
                        <p className="text-xs text-slate-400">Bonus annuel</p>
                        <p className="text-sm font-bold text-brand-main tabular-nums">{formatCurrencyCAD(n(meta.annual_bonus))}</p>
                    </>)}
                </div>
            </div>
        </div>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Th({ children, align, color, className }: {
    children?: React.ReactNode; align: 'left' | 'right'; color: string; className?: string;
}) {
    return (
        <th className={cn(
            "px-3 py-3 text-[10px] font-bold uppercase tracking-widest border-r border-slate-200 last:border-r-0",
            align === 'right' ? 'text-right' : 'text-left',
            color, className
        )}>
            {children}
        </th>
    );
}

function NumInput({ value, onChange, color }: { value: string; onChange: (v: string) => void; color: string }) {
    const [focused, setFocused] = useState(false);
    const [draft, setDraft] = useState(value);

    useEffect(() => { if (!focused) setDraft(value); }, [value, focused]);

    const handleBlur = () => {
        setFocused(false);
        const trimmed = draft.trim();
        if (trimmed === '') return;
        const parsed = parseFloat(trimmed.replace(/[$,\s]/g, '').replace(',', '.'));
        if (isNaN(parsed)) return;
        const formatted = parsed.toFixed(2);
        if (formatted !== draft) onChange(formatted);
    };

    return (
        <td className="px-3 py-2 border-r border-slate-200">
            <input
                type="text"
                value={focused ? draft : value}
                onFocus={() => { setFocused(true); setDraft(value); }}
                onChange={e => {
                    const v = e.target.value.replace(/,/g, '.');
                    setDraft(v);
                    onChange(v);
                }}
                onBlur={handleBlur}
                placeholder="—"
                className={cn(
                    "w-full bg-transparent text-right font-semibold placeholder:text-slate-200 focus:outline-none tabular-nums text-sm min-w-[90px]",
                    color
                )}
            />
        </td>
    );
}

function NumDisplay({ value, color }: { value: number | null; color: string }) {
    return (
        <td className={cn("px-3 py-2 text-right font-semibold tabular-nums text-sm border-r border-slate-200", color)}>
            {value ? formatCurrencyCAD(value) : <span className="text-slate-200">—</span>}
        </td>
    );
}

function TotalCell({ value, color }: { value: number; color: string }) {
    return (
        <td className={cn("px-3 py-3 text-right font-bold tabular-nums border-r border-slate-200", color)}>
            {value > 0 ? formatCurrencyCAD(value) : <span className="text-slate-300">—</span>}
        </td>
    );
}

function MetaCard({ label, value, onChange, bg, text, readOnly }: {
    label: string; value: number; onChange?: (v: string) => void; bg: string; text: string; readOnly?: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value === 0 ? '' : String(value));

    useEffect(() => { if (!editing) setDraft(value === 0 ? '' : String(value)); }, [value, editing]);

    return (
        <div className={cn("p-3 md:p-4 rounded-2xl border", bg)}>
            <p className="text-[9px] md:text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-tight mb-1.5 md:mb-2">{label}</p>
            {readOnly ? (
                <p className={cn("text-base md:text-xl font-bold tabular-nums", text)}>
                    {value ? formatCurrencyCAD(value) : <span className="text-slate-300">—</span>}
                </p>
            ) : (
                <input
                    type="text"
                    value={editing ? draft : (value === 0 ? '' : formatCurrencyCAD(value))}
                    onFocus={() => { setEditing(true); setDraft(value === 0 ? '' : String(value)); }}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={() => { setEditing(false); onChange?.(draft); }}
                    placeholder="0,00$"
                    className={cn("text-base md:text-xl font-bold w-full bg-transparent focus:outline-none placeholder:text-slate-300 tabular-nums", text)}
                />
            )}
        </div>
    );
}
