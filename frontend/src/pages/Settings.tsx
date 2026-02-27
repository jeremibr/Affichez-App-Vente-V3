import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import {
    Users, Target, History, Save, RefreshCcw,
    AlertCircle, CheckCircle2, Calendar, ChevronRight,
    UserPlus, ToggleLeft, ToggleRight, X
} from 'lucide-react';
import { cn, formatShortDate } from '../lib/utils';
import { DEPARTMENTS, MONTHS } from '../lib/constants';
import { Select } from '../components/Select';

type Tab = 'reps' | 'objectives' | 'quarters' | 'logs';

interface Rep {
    id: string;
    name: string;
    office: 'QC' | 'MTL';
    is_active: boolean;
}

interface Objective {
    id: string;
    year: number;
    month: number;
    department: string;
    target_amount: number;
}

interface Quarter {
    id: string;
    year: number;
    quarter: number;
    start_date: string;
    end_date: string;
    num_weeks: number;
}

interface WebhookLog {
    id: string;
    received_at: string;
    action: string;
    status_code: number;
    zoho_id: string | null;
    error_message: string | null;
}

const tabItems: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'reps', label: 'Représentants', icon: Users },
    { id: 'objectives', label: 'Objectifs', icon: Target },
    { id: 'quarters', label: 'Trimestres', icon: Calendar },
    { id: 'logs', label: 'Logs Webhook', icon: History },
];

export default function Settings() {
    const [activeTab, setActiveTab] = useState<Tab>('reps');
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 4000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    return (
        <div className="p-6 md:p-8 max-w-screen-xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Paramètres</h1>
                <p className="text-sm text-slate-400 mt-0.5">Gérez les représentants, les objectifs et le système.</p>
            </div>

            {/* Toast message */}
            {message && (
                <div className={cn(
                    "flex items-center gap-3 p-4 rounded-xl border mb-6 text-sm font-medium",
                    message.type === 'success'
                        ? "bg-emerald-50 border-emerald-100 text-emerald-800"
                        : "bg-red-50 border-red-100 text-red-800"
                )}>
                    {message.type === 'success'
                        ? <CheckCircle2 className="w-4 h-4 shrink-0" />
                        : <AlertCircle className="w-4 h-4 shrink-0" />}
                    {message.text}
                </div>
            )}

            {/* Tabs */}
            <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-6 w-fit">
                {tabItems.map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                            "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                            activeTab === tab.id
                                ? "bg-white text-slate-900 shadow-card"
                                : "text-slate-500 hover:text-slate-700"
                        )}
                    >
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Content */}
            {activeTab === 'reps' && <RepsManager setMessage={setMessage} />}
            {activeTab === 'objectives' && <ObjectivesManager setMessage={setMessage} />}
            {activeTab === 'quarters' && <QuartersViewer />}
            {activeTab === 'logs' && <WebhookLogs />}
        </div>
    );
}

// ─── Reps Manager ────────────────────────────────────────────────────────────
function RepsManager({ setMessage }: { setMessage: (m: { type: 'success' | 'error', text: string }) => void }) {
    const [reps, setReps] = useState<Rep[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [newRep, setNewRep] = useState({ name: '', office: 'QC' });

    useEffect(() => { fetchReps(); }, []);

    const fetchReps = async () => {
        setLoading(true);
        const { data, error } = await supabase.from('reps').select('*').order('name');
        if (error) console.error(error);
        else setReps(data || []);
        setLoading(false);
    };

    const toggleActive = async (id: string, currentStatus: boolean) => {
        const { error } = await supabase.from('reps').update({ is_active: !currentStatus }).eq('id', id);
        if (error) setMessage({ type: 'error', text: 'Erreur lors de la modification.' });
        else { setMessage({ type: 'success', text: 'Statut mis à jour.' }); fetchReps(); }
    };

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newRep.name.trim()) return;
        const { error } = await supabase.from('reps').insert([newRep]);
        if (error) {
            setMessage({ type: 'error', text: 'Erreur lors de l\'ajout. Le nom doit être unique.' });
        } else {
            setMessage({ type: 'success', text: 'Représentant ajouté avec succès.' });
            setNewRep({ name: '', office: 'QC' });
            setIsAdding(false);
            fetchReps();
        }
    };

    const officeOptions = [
        { value: 'QC', label: 'Québec (QC)' },
        { value: 'MTL', label: 'Montréal (MTL)' }
    ];

    return (
        <div className="space-y-4 max-w-3xl">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-800">Représentants actifs</h2>
                <button
                    onClick={() => setIsAdding(!isAdding)}
                    className={cn(
                        "flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-all",
                        isAdding
                            ? "bg-slate-100 text-slate-600 hover:bg-slate-200"
                            : "bg-brand-main text-white shadow-sm shadow-brand-main/30 hover:bg-brand-main/90"
                    )}
                >
                    {isAdding ? <><X className="w-4 h-4" /> Annuler</> : <><UserPlus className="w-4 h-4" /> Ajouter</>}
                </button>
            </div>

            {isAdding && (
                <form onSubmit={handleAdd} className="bg-white border border-slate-100 shadow-card rounded-2xl p-5 flex flex-col sm:flex-row gap-4 items-end">
                    <div className="flex-1 space-y-1">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest px-1">Nom complet</label>
                        <input
                            type="text"
                            className="w-full bg-slate-50 border-0 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-main/30"
                            placeholder="ex: Jean Dupont"
                            value={newRep.name}
                            onChange={e => setNewRep({ ...newRep, name: e.target.value })}
                            required
                        />
                    </div>
                    <div className="w-full sm:w-48 space-y-1">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest px-1">Bureau</label>
                        <Select
                            value={newRep.office}
                            onChange={(val) => setNewRep({ ...newRep, office: val as any })}
                            options={officeOptions}
                        />
                    </div>
                    <button type="submit" className="bg-slate-900 text-white px-6 py-2.5 rounded-xl hover:bg-slate-800 transition-all text-sm font-semibold whitespace-nowrap">
                        Enregistrer
                    </button>
                </form>
            )}

            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Nom</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Bureau</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Statut</th>
                            <th className="px-5 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-widest">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {loading ? (
                            <tr><td colSpan={4} className="px-5 py-10 text-center text-slate-400 italic text-sm">Chargement...</td></tr>
                        ) : reps.map(rep => (
                            <tr key={rep.id} className="hover:bg-slate-50/60 transition-colors">
                                <td className="px-5 py-3.5 font-semibold text-slate-800">{rep.name}</td>
                                <td className="px-5 py-3.5">
                                    <span className={cn(
                                        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold",
                                        rep.office === 'QC' ? "bg-blue-50 text-blue-600" : "bg-violet-50 text-violet-600"
                                    )}>
                                        {rep.office}
                                    </span>
                                </td>
                                <td className="px-5 py-3.5">
                                    <span className={cn(
                                        "inline-flex items-center gap-1.5 text-xs font-semibold",
                                        rep.is_active ? "text-emerald-600" : "text-slate-400"
                                    )}>
                                        <div className={cn("w-1.5 h-1.5 rounded-full", rep.is_active ? "bg-emerald-500" : "bg-slate-300")} />
                                        {rep.is_active ? 'Actif' : 'Inactif'}
                                    </span>
                                </td>
                                <td className="px-5 py-3.5 text-right">
                                    <button
                                        onClick={() => toggleActive(rep.id, rep.is_active)}
                                        className="p-2 rounded-lg text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-all"
                                        title={rep.is_active ? 'Désactiver' : 'Activer'}
                                    >
                                        {rep.is_active
                                            ? <ToggleRight className="w-5 h-5 text-brand-main" />
                                            : <ToggleLeft className="w-5 h-5" />}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ─── Objectives Manager ───────────────────────────────────────────────────────
function ObjectivesManager({ setMessage }: { setMessage: (m: { type: 'success' | 'error', text: string }) => void }) {
    const [year, setYear] = useState(new Date().getFullYear());
    const [objectives, setObjectives] = useState<Objective[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => { fetchObjectives(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

    const fetchObjectives = async () => {
        setLoading(true);
        const { data, error } = await supabase.from('objectives').select('*').eq('year', year);
        if (error) console.error(error);
        else setObjectives(data || []);
        setLoading(false);
    };

    const handleUpdate = (month: number, dept: string, value: string) => {
        const amount = parseFloat(value) || 0;
        const existing = objectives.find(o => o.month === month && o.department === dept);
        if (existing) {
            setObjectives(prev => prev.map(o => o.id === existing.id ? { ...o, target_amount: amount } : o));
        } else {
            setObjectives(prev => [...prev, { year, month, department: dept, target_amount: amount, id: 'temp-' + Date.now() }]);
        }
    };

    const saveAll = async () => {
        setSaving(true);
        const toSave = objectives.map(o => ({ year, month: o.month, department: o.department, target_amount: o.target_amount }));
        const { error: delError } = await supabase.from('objectives').delete().eq('year', year);
        if (delError) { setMessage({ type: 'error', text: 'Erreur lors du nettoyage.' }); setSaving(false); return; }
        const { error: insError } = await supabase.from('objectives').insert(toSave);
        if (insError) setMessage({ type: 'error', text: 'Erreur lors de la sauvegarde.' });
        else { setMessage({ type: 'success', text: 'Objectifs sauvegardés.' }); fetchObjectives(); }
        setSaving(false);
    };

    const yearOptions = [2024, 2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold text-slate-800">Objectifs par département</h2>
                    <Select
                        value={String(year)}
                        onChange={(val) => setYear(Number(val))}
                        options={yearOptions}
                        variant="accent"
                        className="w-24"
                    />
                </div>
                <button
                    onClick={saveAll}
                    disabled={saving}
                    className="flex items-center gap-2 bg-brand-main text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-sm shadow-brand-main/30 hover:bg-brand-main/90 transition-all disabled:opacity-50"
                >
                    {saving ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Enregistrer
                </button>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                    <thead>
                        <tr className="border-b border-slate-100">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest sticky left-0 bg-white">Mois</th>
                            {DEPARTMENTS.map(dept => (
                                <th key={dept} className="px-4 py-3 text-center text-xs font-semibold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                    {dept.length > 15 ? dept.substring(0, 13) + '…' : dept}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {loading ? (
                            <tr><td colSpan={7} className="px-5 py-10 text-center text-slate-400 italic text-sm">Chargement...</td></tr>
                        ) : MONTHS.map((month) => {
                            const monthNum = month.value;
                            return (
                                <tr key={month.value} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-5 py-2.5 font-semibold text-slate-700 sticky left-0 bg-white whitespace-nowrap">{month.label}</td>
                                    {DEPARTMENTS.map(dept => {
                                        const obj = objectives.find(o => o.month === monthNum && o.department === dept);
                                        return (
                                            <td key={dept} className="px-3 py-2">
                                                <input
                                                    type="number"
                                                    className="w-full bg-slate-50 border-0 rounded-lg px-3 py-2 text-right text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-main/30 focus:bg-white transition-all"
                                                    value={obj?.target_amount || ''}
                                                    placeholder="0"
                                                    onChange={e => handleUpdate(monthNum, dept, e.target.value)}
                                                />
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="text-xs text-slate-400 px-1">* Montants avant taxes. Sauvegardez après chaque modification.</p>
        </div>
    );
}

// ─── Quarters Viewer ──────────────────────────────────────────────────────────
function QuartersViewer() {
    const [quarters, setQuarters] = useState<Quarter[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        supabase.from('fiscal_quarters').select('*').order('year', { ascending: false }).order('quarter')
            .then(({ data, error }) => {
                if (error) console.error(error);
                else setQuarters(data || []);
                setLoading(false);
            });
    }, []);

    return (
        <div className="space-y-4 max-w-3xl">
            <h2 className="text-base font-semibold text-slate-800">Calendrier Fiscal (13 semaines / trimestre)</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {loading ? (
                    <div className="col-span-2 py-10 text-center text-slate-400 italic text-sm">Chargement...</div>
                ) : quarters.map(q => (
                    <div key={q.id} className="bg-white border border-slate-100 shadow-card rounded-2xl p-5 flex items-center justify-between hover:border-brand-main/20 transition-colors">
                        <div>
                            <div className="text-xs font-bold text-brand-main uppercase tracking-widest mb-0.5">Trimestre #{q.quarter}</div>
                            <div className="font-bold text-slate-800">Année {q.year}</div>
                            <div className="text-xs text-slate-400 mt-0.5">{q.num_weeks} semaines</div>
                        </div>
                        <div className="text-right">
                            <div className="text-sm font-medium text-slate-700">
                                {formatShortDate(q.start_date)}
                            </div>
                            <ChevronRight className="w-4 h-4 text-slate-300 mx-auto my-0.5" />
                            <div className="text-sm font-medium text-slate-700">
                                {formatShortDate(q.end_date)}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── Webhook Logs ─────────────────────────────────────────────────────────────
function WebhookLogs() {
    const [logs, setLogs] = useState<WebhookLog[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchLogs = async () => {
        const { data, error } = await supabase.from('webhook_log').select('*').order('received_at', { ascending: false }).limit(20);
        if (error) console.error(error);
        else setLogs(data || []);
        setLoading(false);
    };

    useEffect(() => { fetchLogs(); }, []);

    return (
        <div className="space-y-4 max-w-4xl">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-800">Historique Webhook (20 derniers)</h2>
                <button onClick={fetchLogs} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Actualiser">
                    <RefreshCcw className="w-4 h-4" />
                </button>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Date</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Événement</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Status</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Devis #</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {loading ? (
                            <tr><td colSpan={4} className="px-5 py-10 text-center text-slate-400 italic text-sm">Chargement...</td></tr>
                        ) : logs.length === 0 ? (
                            <tr><td colSpan={4} className="px-5 py-10 text-center text-slate-400 italic text-sm">Aucun log trouvé.</td></tr>
                        ) : logs.map(log => (
                            <tr key={log.id} className="hover:bg-slate-50/60 transition-colors">
                                <td className="px-5 py-3 text-slate-400 text-xs">{new Date(log.received_at).toLocaleString('fr-CA')}</td>
                                <td className="px-5 py-3">
                                    <span className={cn(
                                        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold",
                                        log.action === 'upserted' ? "bg-emerald-50 text-emerald-700"
                                            : log.action === 'deleted' ? "bg-red-50 text-red-700"
                                                : "bg-slate-100 text-slate-600"
                                    )}>
                                        {log.action}
                                    </span>
                                </td>
                                <td className="px-5 py-3 font-mono text-xs text-slate-500">{log.status_code}</td>
                                <td className="px-5 py-3 font-medium text-slate-700">{log.zoho_id || '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {logs.some(l => l.error_message) && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
                    <h3 className="text-sm font-semibold text-red-800 flex items-center gap-2 mb-2">
                        <AlertCircle className="w-4 h-4" /> Erreurs récentes :
                    </h3>
                    <ul className="text-xs text-red-700 space-y-1 ml-6 list-disc">
                        {logs.filter(l => l.error_message).map(l => (
                            <li key={l.id}>{l.error_message} (ID: {l.zoho_id})</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
