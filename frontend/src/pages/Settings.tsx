import { useState, useEffect } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import {
    Target, History, Save, RefreshCcw,
    AlertCircle, CheckCircle2, Calendar, ChevronRight,
    Zap, Loader2, Users, Trash2, Plus, FileText
} from 'lucide-react';
import { cn, formatShortDate } from '../lib/utils';
import { DEPARTMENTS, MONTHS } from '../lib/constants';
import { Select } from '../components/Select';
import { useAuth } from '../contexts/AuthContext';

type Tab = 'objectives' | 'quarters' | 'sync' | 'logs' | 'users';

interface Objective { id: string; year: number; month: number; department: string; target_amount: number; }
interface Quarter { id: string; year: number; quarter: number; start_date: string; end_date: string; num_weeks: number; }
interface WebhookLog { id: string; received_at: string; action: string; status_code: number; zoho_id: string | null; error_message: string | null; }
interface AllowedUser { email: string; name: string | null; role: string; can_access_factures: boolean; rep_name: string | null; }

export default function Settings() {
    const { isAdmin } = useAuth();
    const [activeTab, setActiveTab] = useUrlState('tab', 'objectives') as [Tab, (v: Tab) => void];
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    const tabItems: { id: Tab; label: string; icon: React.ElementType; adminOnly?: boolean }[] = [
        { id: 'objectives', label: 'Objectifs', icon: Target },
        { id: 'quarters', label: 'Trimestres', icon: Calendar },
        { id: 'sync', label: 'Synchronisation', icon: Zap },
        { id: 'logs', label: 'Historique', icon: History },
        { id: 'users', label: 'Utilisateurs', icon: Users, adminOnly: true },
    ];

    useEffect(() => {
        if (message) { const t = setTimeout(() => setMessage(null), 4000); return () => clearTimeout(t); }
    }, [message]);

    const visibleTabs = tabItems.filter(t => !t.adminOnly || isAdmin);

    return (
        <div className="p-4 md:p-8 max-w-screen-xl mx-auto">
            <div className="mb-6">
                <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Paramètres</h1>
                <p className="text-xs md:text-sm text-slate-400 mt-0.5">Objectifs, trimestres, synchronisation et utilisateurs.</p>
            </div>

            {message && (
                <div className={cn("flex items-center gap-3 p-4 rounded-xl border mb-6 text-sm font-medium",
                    message.type === 'success' ? "bg-emerald-50 border-emerald-100 text-emerald-800" : "bg-red-50 border-red-100 text-red-800")}>
                    {message.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                    {message.text}
                </div>
            )}

            <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-6 overflow-x-auto max-w-full">
                {visibleTabs.map(tab => (
                    <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                        className={cn("flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                            activeTab === tab.id ? "bg-white text-slate-900 shadow-card" : "text-slate-500 hover:text-slate-700")}>
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {activeTab === 'objectives' && <ObjectivesManager setMessage={setMessage} />}
            {activeTab === 'quarters' && <QuartersViewer />}
            {activeTab === 'sync' && <SyncManager />}
            {activeTab === 'logs' && <WebhookLogs />}
            {activeTab === 'users' && isAdmin && <UsersManager setMessage={setMessage} />}
        </div>
    );
}

// ─── Objectives Manager (Devis + Factures) ────────────────────────────────────
function ObjectivesManager({ setMessage }: { setMessage: (m: { type: 'success' | 'error', text: string }) => void }) {
    const [module, setModule] = useUrlState('obj_module', 'devis') as ['devis' | 'factures', (v: 'devis' | 'factures') => void];
    const [year, setYear] = useUrlStateNumber('obj_year', new Date().getFullYear());
    const [objectives, setObjectives] = useState<Objective[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const table = module === 'devis' ? 'objectives' : 'objectives_factures';

    useEffect(() => { fetchObjectives(); }, [year, module]); // eslint-disable-line react-hooks/exhaustive-deps

    const fetchObjectives = async () => {
        setLoading(true);
        const { data, error } = await supabase.from(table).select('*').eq('year', year);
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
        const { error: delError } = await supabase.from(table).delete().eq('year', year);
        if (delError) { setMessage({ type: 'error', text: 'Erreur lors du nettoyage.' }); setSaving(false); return; }
        const { error: insError } = await supabase.from(table).insert(toSave);
        if (insError) setMessage({ type: 'error', text: 'Erreur lors de la sauvegarde.' });
        else { setMessage({ type: 'success', text: 'Objectifs sauvegardés.' }); fetchObjectives(); }
        setSaving(false);
    };

    const yearOptions = [2024, 2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-base font-semibold text-slate-800">Objectifs par département</h2>
                    {/* Module toggle */}
                    <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg">
                        <button onClick={() => setModule('devis')}
                            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all",
                                module === 'devis' ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700")}>
                            Devis
                        </button>
                        <button onClick={() => setModule('factures')}
                            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all",
                                module === 'factures' ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700")}>
                            <FileText className="w-3 h-3" /> Factures
                        </button>
                    </div>
                    <Select value={String(year)} onChange={(val) => setYear(Number(val))} options={yearOptions} variant="accent" className="w-24" />
                </div>
                <button onClick={saveAll} disabled={saving}
                    className="flex items-center gap-2 bg-brand-main text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-sm shadow-brand-main/30 hover:bg-brand-main/90 transition-all disabled:opacity-50">
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
                                                <input type="number"
                                                    className="w-full bg-slate-50 border-0 rounded-lg px-3 py-2 text-right text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-main/30 focus:bg-white transition-all"
                                                    value={obj?.target_amount || ''}
                                                    placeholder="0"
                                                    onChange={e => handleUpdate(monthNum, dept, e.target.value)} />
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
            .then(({ data, error }) => { if (error) console.error(error); else setQuarters(data || []); setLoading(false); });
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
                            <div className="text-sm font-medium text-slate-700">{formatShortDate(q.start_date)}</div>
                            <ChevronRight className="w-4 h-4 text-slate-300 mx-auto my-0.5" />
                            <div className="text-sm font-medium text-slate-700">{formatShortDate(q.end_date)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── Sync Manager ─────────────────────────────────────────────────────────────
interface SyncResult { upserted: number; deleted?: number; voided?: number; errors: string[]; duration_ms: number; }

function SyncManager() {
    return (
        <div className="space-y-8 max-w-3xl">
            <SyncCard
                title="Synchronisation Devis (Zoho Books)"
                description="Importe les devis Acceptés et Facturés depuis QC + MTL. Les devis refusés sont mis à jour automatiquement."
                endpoint="zoho-sync"
                actionLabel="sync_manual"
            />
            <SyncCard
                title="Synchronisation Factures (Zoho Books)"
                description="Importe les factures Payées, Partielles, Envoyées et En retard depuis QC + MTL. Inclut les factures d'avoir (crédits)."
                endpoint="zoho-invoice-sync"
                actionLabel="sync_invoices_manual"
            />
            <div className="flex items-start gap-3 px-4 py-3 bg-slate-50 rounded-xl border border-slate-100 text-xs text-slate-500">
                <Calendar className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <span>
                    Synchronisation automatique planifiée chaque jour à <strong className="text-slate-700">6h00</strong> (heure de Montréal) via pg_cron.
                </span>
            </div>
        </div>
    );
}

function SyncCard({ title, description, endpoint, actionLabel }: { title: string; description: string; endpoint: string; actionLabel: string }) {
    const [syncing, setSyncing] = useState(false);
    const [fullSyncing, setFullSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [lastSync, setLastSync] = useState<WebhookLog | null>(null);
    const [recentLogs, setRecentLogs] = useState<WebhookLog[]>([]);
    const [logsLoading, setLogsLoading] = useState(true);

    const fetchSyncLogs = async () => {
        setLogsLoading(true);
        const { data } = await supabase.from('webhook_log').select('*')
            .like('action', actionLabel.replace('_manual', '%'))
            .order('received_at', { ascending: false }).limit(8);
        const logs = data || [];
        setRecentLogs(logs);
        setLastSync(logs[0] ?? null);
        setLogsLoading(false);
    };

    useEffect(() => { fetchSyncLogs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const runSync = async (fullSync: boolean) => {
        if (fullSync) setFullSyncing(true); else setSyncing(true);
        setSyncResult(null); setSyncError(null);
        try {
            const headers: Record<string, string> = {
                Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                'x-sync-source': 'manual',
            };
            if (fullSync) headers['x-full-sync'] = 'true';
            const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`, {
                method: 'POST', headers,
            });
            const data = await res.json();
            if (!res.ok) setSyncError(data.error ?? 'Erreur inconnue');
            else { setSyncResult(data as SyncResult); fetchSyncLogs(); }
        } catch (err) { setSyncError(err instanceof Error ? err.message : 'Erreur réseau'); }
        if (fullSync) setFullSyncing(false); else setSyncing(false);
    };

    const handleSync = () => runSync(false);
    const handleFullSync = () => runSync(true);

    const formatRelative = (iso: string) => {
        const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
        if (diffMin < 1) return 'il y a quelques secondes';
        if (diffMin < 60) return `il y a ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `il y a ${diffH}h`;
        return `il y a ${Math.floor(diffH / 24)}j`;
    };

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
                        <Zap className="w-4 h-4 text-brand-main" />{title}
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">{description}</p>
                    {lastSync && (
                        <p className="text-xs text-slate-500 mt-2 font-medium">
                            Dernière sync : <span className="text-slate-700">{formatRelative(lastSync.received_at)}</span>
                            {' '}— <span className="font-mono text-[11px] text-slate-400">{new Date(lastSync.received_at).toLocaleString('fr-CA')}</span>
                        </p>
                    )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                    <button onClick={handleSync} disabled={syncing || fullSyncing}
                        className="flex items-center gap-2 bg-brand-main text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-sm shadow-brand-main/30 hover:bg-brand-main/90 transition-all disabled:opacity-60">
                        {syncing ? <><Loader2 className="w-4 h-4 animate-spin" /> Sync...</> : <><RefreshCcw className="w-4 h-4" /> Synchroniser</>}
                    </button>
                    <button onClick={handleFullSync} disabled={syncing || fullSyncing}
                        className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-main transition-colors disabled:opacity-50"
                        title="Importe tout l'historique sans filtre de date (plus lent)">
                        {fullSyncing ? <><Loader2 className="w-3 h-3 animate-spin" /> Sync complète...</> : <><RefreshCcw className="w-3 h-3" /> Sync complète (historique)</>}
                    </button>
                </div>
            </div>

            {syncResult && (
                <div className="pt-4 border-t border-slate-100 flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
                        <CheckCircle2 className="w-4 h-4" />{syncResult.upserted} upsertés
                    </div>
                    {syncResult.deleted !== undefined && <><div className="text-slate-300">|</div><div className="text-sm font-semibold text-slate-500">{syncResult.deleted} supprimés</div></>}
                    {syncResult.voided !== undefined && <><div className="text-slate-300">|</div><div className="text-sm font-semibold text-slate-500">{syncResult.voided} annulés</div></>}
                    <div className="text-slate-300">|</div>
                    <div className="text-xs text-slate-400 font-mono">{(syncResult.duration_ms / 1000).toFixed(1)}s</div>
                    {syncResult.errors.length > 0 && (
                        <div className="w-full text-xs text-red-600 bg-red-50 rounded-lg p-2">{syncResult.errors.join(' · ')}</div>
                    )}
                </div>
            )}
            {syncError && (
                <div className="pt-4 border-t border-slate-100 flex items-center gap-2 text-sm text-red-600">
                    <AlertCircle className="w-4 h-4 shrink-0" />{syncError}
                </div>
            )}

            {/* Recent history */}
            <div className="pt-2">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">Historique récent</h3>
                    <button onClick={fetchSyncLogs} className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"><RefreshCcw className="w-3 h-3" /></button>
                </div>
                <div className="bg-slate-50 rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                        <tbody className="divide-y divide-slate-100">
                            {logsLoading ? (
                                <tr><td className="px-4 py-3 text-center text-slate-400 italic">Chargement...</td></tr>
                            ) : recentLogs.length === 0 ? (
                                <tr><td className="px-4 py-3 text-center text-slate-400 italic">Aucune synchronisation.</td></tr>
                            ) : recentLogs.map(log => (
                                <tr key={log.id} className="hover:bg-slate-100/60">
                                    <td className="px-4 py-2.5 text-slate-400">{new Date(log.received_at).toLocaleString('fr-CA')}</td>
                                    <td className="px-4 py-2.5">
                                        <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase",
                                            log.action.includes('full') ? "bg-purple-100 text-purple-600" :
                                            log.action.includes('manual') ? "bg-brand-main/10 text-brand-main" :
                                            "bg-slate-200 text-slate-500")}>
                                            {log.action.includes('full') ? 'Complète' : log.action.includes('manual') ? 'Manuel' : 'Auto'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <span className={cn("flex items-center gap-1 font-semibold", log.status_code === 200 ? "text-emerald-600" : "text-red-500")}>
                                            {log.status_code === 200 ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}{log.status_code}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-slate-400 max-w-[200px] truncate">{log.error_message || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
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
        if (error) console.error(error); else setLogs(data || []);
        setLoading(false);
    };

    useEffect(() => { fetchLogs(); }, []);

    return (
        <div className="space-y-4 max-w-4xl">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-800">Historique Webhook (20 derniers)</h2>
                <button onClick={fetchLogs} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"><RefreshCcw className="w-4 h-4" /></button>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Date</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Événement</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Status</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Réf.</th>
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
                                    <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold",
                                        log.action === 'upserted' ? "bg-emerald-50 text-emerald-700" : log.action === 'deleted' ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600")}>
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
        </div>
    );
}

// ─── Users Manager (admin only) ───────────────────────────────────────────────
function UsersManager({ setMessage }: { setMessage: (m: { type: 'success' | 'error', text: string }) => void }) {
    const [users, setUsers] = useState<AllowedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState<AllowedUser>({ email: '', name: '', role: 'member', can_access_factures: false, rep_name: '' });
    const [saving, setSaving] = useState(false);
    const [repOptions, setRepOptions] = useState<string[]>([]);
    const [zohoUsers, setZohoUsers] = useState<{ name: string; email: string }[]>([]);
    const [zohoUsersLoading, setZohoUsersLoading] = useState(false);
    const [zohoUsersError, setZohoUsersError] = useState(false);

    useEffect(() => {
        supabase.rpc('get_distinct_rep_names').then(({ data }) => {
            if (data) setRepOptions((data as { rep_name: string }[]).map(r => r.rep_name));
        });
        setZohoUsersLoading(true);
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-zoho-users`, {
            headers: {
                Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            },
        })
            .then(r => r.json())
            .then(data => {
                if (data.users?.length) setZohoUsers(data.users);
                else setZohoUsersError(true);
            })
            .catch(() => setZohoUsersError(true))
            .finally(() => setZohoUsersLoading(false));
    }, []);

    const fetchUsers = async () => {
        setLoading(true);
        const { data, error } = await supabase.from('allowed_users').select('*').order('email');
        if (error) console.error(error); else setUsers(data || []);
        setLoading(false);
    };

    useEffect(() => { fetchUsers(); }, []);

    const handleSave = async () => {
        if (!form.email.trim()) return;
        setSaving(true);
        const payload = {
            email: form.email.trim().toLowerCase(),
            name: form.name?.trim() || null,
            role: form.role,
            can_access_factures: form.can_access_factures,
            rep_name: form.rep_name?.trim() || null,
        };
        const { error } = await supabase.from('allowed_users').upsert(payload, { onConflict: 'email' });
        if (error) setMessage({ type: 'error', text: 'Erreur: ' + error.message });
        else { setMessage({ type: 'success', text: 'Utilisateur sauvegardé.' }); setShowForm(false); setForm({ email: '', name: '', role: 'member', can_access_factures: false, rep_name: '' }); fetchUsers(); }
        setSaving(false);
    };

    const handleDelete = async (email: string) => {
        if (!confirm(`Supprimer l'accès pour ${email} ?`)) return;
        const { error } = await supabase.from('allowed_users').delete().eq('email', email);
        if (error) setMessage({ type: 'error', text: 'Erreur: ' + error.message });
        else { setMessage({ type: 'success', text: 'Utilisateur supprimé.' }); fetchUsers(); }
    };

    const handleEdit = (user: AllowedUser) => {
        setForm({ ...user, name: user.name ?? '', rep_name: user.rep_name ?? '' });
        setShowForm(true);
    };

    return (
        <div className="space-y-6 max-w-4xl">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-base font-semibold text-slate-800">Gestion des utilisateurs</h2>
                    <p className="text-xs text-slate-400 mt-0.5">Contrôlez qui peut se connecter et accéder au module Factures.</p>
                </div>
                <button onClick={() => { setForm({ email: '', name: '', role: 'member', can_access_factures: false, rep_name: '' }); setShowForm(true); }}
                    className="flex items-center gap-2 bg-brand-main text-white px-4 py-2 rounded-xl text-sm font-semibold shadow-sm shadow-brand-main/30 hover:bg-brand-main/90 transition-all">
                    <Plus className="w-4 h-4" /> Ajouter
                </button>
            </div>

            {/* Add/Edit Form */}
            {showForm && (() => {
                const isEditing = !!(form.email && users.find(u => u.email === form.email));
                return (
                <div className="bg-white border border-brand-main/20 rounded-2xl p-5 shadow-card space-y-4">
                    <h3 className="text-sm font-bold text-slate-800">
                        {isEditing ? 'Modifier' : 'Ajouter'} un utilisateur
                    </h3>

                    {/* User identity row */}
                    {isEditing ? (
                        /* Editing: email is locked, show as display */
                        <div className="flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3">
                            <div className="w-8 h-8 rounded-full bg-brand-main/10 text-brand-main flex items-center justify-center text-sm font-bold shrink-0">
                                {(form.name || form.email).charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-slate-800 truncate">{form.name || '—'}</p>
                                <p className="text-xs text-slate-400 truncate">{form.email}</p>
                            </div>
                        </div>
                    ) : (
                        /* Adding: Zoho user picker */
                        <div>
                            <label className="block text-xs font-semibold text-slate-500 mb-1.5">
                                Utilisateur Zoho *
                            </label>
                            {zohoUsersError ? (
                                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs text-amber-700 space-y-2">
                                    <p className="font-semibold">Impossible de charger les utilisateurs Zoho.</p>
                                    <p>Vérifiez que la fonction <code className="font-mono bg-amber-100 px-1 rounded">get-zoho-users</code> est déployée et que le token Zoho a le scope <code className="font-mono bg-amber-100 px-1 rounded">ZohoBooks.settings.READ</code>.</p>
                                    <p>En attendant, entrez le courriel manuellement :</p>
                                    <input
                                        type="email"
                                        value={form.email}
                                        onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-amber-200 focus:outline-none focus:ring-2 focus:ring-brand-main/30"
                                        placeholder="jean@affichez.ca"
                                    />
                                </div>
                            ) : (
                                <select
                                    value={form.email}
                                    onChange={e => {
                                        const u = zohoUsers.find(z => z.email === e.target.value);
                                        if (u) {
                                            const matched = repOptions.find(r => r.toLowerCase() === u.name.toLowerCase()) ?? '';
                                            setForm(f => ({ ...f, email: u.email, name: u.name, rep_name: matched }));
                                        } else {
                                            setForm(f => ({ ...f, email: '', name: '', rep_name: '' }));
                                        }
                                    }}
                                    disabled={zohoUsersLoading}
                                    className="w-full bg-slate-50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-main/30 disabled:text-slate-400"
                                >
                                    <option value="">
                                        {zohoUsersLoading ? 'Chargement des utilisateurs Zoho…' : '— Sélectionner un utilisateur Zoho —'}
                                    </option>
                                    {zohoUsers.map(u => (
                                        <option key={u.email} value={u.email}>
                                            {u.name} — {u.email}
                                        </option>
                                    ))}
                                </select>
                            )}
                            {form.email && !zohoUsersError && (
                                <div className="flex items-center gap-2 mt-2 pl-1">
                                    <span className="text-xs text-slate-400 truncate">{form.email}</span>
                                    {form.rep_name && (
                                        <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full shrink-0">
                                            <CheckCircle2 className="w-3 h-3" /> Associé : {form.rep_name}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Permissions grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-semibold text-slate-500 mb-1">Rôle</label>
                            <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                                className="w-full bg-slate-50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-main/30">
                                <option value="member">Membre</option>
                                <option value="admin">Admin</option>
                            </select>
                        </div>
                        {/* Rep name: auto-matched on add, manually editable on edit */}
                        {isEditing && (
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 mb-1">Représentant Zoho</label>
                                <select
                                    value={form.rep_name ?? ''}
                                    onChange={e => setForm(f => ({ ...f, rep_name: e.target.value }))}
                                    className="w-full bg-slate-50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-main/30"
                                >
                                    <option value="">— Aucun —</option>
                                    {repOptions.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                        <input type="checkbox" id="factures-access" checked={form.can_access_factures}
                            onChange={e => setForm(f => ({ ...f, can_access_factures: e.target.checked }))}
                            className="w-4 h-4 accent-brand-main rounded" />
                        <label htmlFor="factures-access" className="text-sm font-medium text-slate-700 cursor-pointer">Accès au module Factures</label>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={handleSave} disabled={saving || !form.email.trim()}
                            className="flex items-center gap-2 bg-brand-main text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-brand-main/90 transition-all disabled:opacity-50">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Enregistrer
                        </button>
                        <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-xl text-sm font-medium text-slate-500 hover:bg-slate-100 transition-all">Annuler</button>
                    </div>
                </div>
                );
            })()}

            {/* Users Table */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Courriel</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Nom</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Rôle</th>
                            <th className="px-5 py-3 text-center text-xs font-semibold text-slate-400 uppercase tracking-widest">Factures</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-widest">Rep Zoho</th>
                            <th className="px-5 py-3 text-center text-xs font-semibold text-slate-400 uppercase tracking-widest">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {loading ? (
                            <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-400 italic">Chargement...</td></tr>
                        ) : users.length === 0 ? (
                            <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-400 italic">Aucun utilisateur enregistré.</td></tr>
                        ) : users.map(user => (
                            <tr key={user.email} className="hover:bg-slate-50/60 transition-colors">
                                <td className="px-5 py-3 text-slate-700 font-medium">{user.email}</td>
                                <td className="px-5 py-3 text-slate-500">{user.name || '—'}</td>
                                <td className="px-5 py-3">
                                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide",
                                        user.role === 'admin' ? "bg-brand-main/10 text-brand-main" : "bg-slate-100 text-slate-500")}>
                                        {user.role}
                                    </span>
                                </td>
                                <td className="px-5 py-3 text-center">
                                    {user.can_access_factures
                                        ? <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" />
                                        : <span className="text-slate-300 text-xs">—</span>}
                                </td>
                                <td className="px-5 py-3">
                                    {user.rep_name
                                        ? repOptions.some(r => r.toLowerCase() === user.rep_name!.toLowerCase())
                                            ? <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />{user.rep_name}
                                              </span>
                                            : <span className="text-xs text-amber-600 font-medium">{user.rep_name}</span>
                                        : <span className="text-slate-300 text-xs">—</span>}
                                </td>
                                <td className="px-5 py-3 text-center">
                                    <div className="flex items-center justify-center gap-1">
                                        <button onClick={() => handleEdit(user)}
                                            className="p-1.5 text-slate-400 hover:text-brand-main hover:bg-amber-50 rounded-lg transition-all text-xs font-bold">
                                            Éditer
                                        </button>
                                        <button onClick={() => handleDelete(user.email)}
                                            className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all">
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="text-xs text-slate-400 px-1">
                Les utilisateurs pré-configurés ici obtiennent automatiquement leur rôle et accès lors de leur première connexion via Zoho. Les membres avec Accès Factures ne voient que leurs propres données.
            </p>
        </div>
    );
}
