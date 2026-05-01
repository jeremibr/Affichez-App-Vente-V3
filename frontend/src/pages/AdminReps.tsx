import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Loader2, ClipboardList, FileText, Wallet, User, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import PortailDevis from './PortailDevis';
import PortailFactures from './PortailFactures';
import PortailPaye from './PortailPaye';

type Tab = 'devis' | 'factures' | 'paye';

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'devis',     label: 'Devis',     icon: ClipboardList },
    { key: 'factures',  label: 'Factures',  icon: FileText },
    { key: 'paye',      label: 'Paye',      icon: Wallet },
];

// ─── Rep picker ───────────────────────────────────────────────────────────────

function RepPicker({ reps, selected, onChange }: {
    reps: string[];
    selected: string;
    onChange: (rep: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2.5 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-semibold text-slate-700 hover:border-brand-main hover:text-brand-main transition-all shadow-sm min-w-[200px]"
            >
                <div className="w-7 h-7 rounded-full bg-brand-main/10 text-brand-main flex items-center justify-center text-xs font-bold shrink-0">
                    {selected ? selected.charAt(0) : <User className="w-3.5 h-3.5" />}
                </div>
                <span className="flex-1 text-left">{selected || 'Choisir un représentant'}</span>
                <ChevronDown className={cn("w-4 h-4 text-slate-400 transition-transform", open && "rotate-180")} />
            </button>

            {open && (
                <div className="absolute top-full left-0 mt-2 w-64 bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden z-30">
                    <div className="px-3 py-2 border-b border-slate-100">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Représentants</p>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                        {reps.length === 0 ? (
                            <p className="px-4 py-3 text-sm text-slate-400">Aucun représentant trouvé</p>
                        ) : reps.map(rep => (
                            <button
                                key={rep}
                                onClick={() => { onChange(rep); setOpen(false); }}
                                className={cn(
                                    "w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors text-left",
                                    rep === selected
                                        ? "bg-brand-main/5 text-brand-main font-semibold"
                                        : "text-slate-700 hover:bg-slate-50 font-medium"
                                )}
                            >
                                <div className={cn(
                                    "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                                    rep === selected ? "bg-brand-main/20 text-brand-main" : "bg-slate-100 text-slate-500"
                                )}>
                                    {rep.charAt(0)}
                                </div>
                                {rep}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AdminReps() {
    const { isAdmin } = useAuth();

    const [allReps, setAllReps]     = useState<string[]>([]);
    const [selectedRep, setSelectedRep] = useState('');
    const [activeTab, setActiveTab] = useState<Tab>('devis');
    const [loadingReps, setLoadingReps] = useState(true);

    // Load rep list once from the leaderboard RPC
    const loadReps = useCallback(async () => {
        setLoadingReps(true);
        const { data } = await supabase.rpc('get_inv_rep_leaderboard', {
            p_year: 2026, p_office: null, p_status: null,
            p_month: null, p_dept: null, p_rep: null,
        });
        if (data && Array.isArray(data) && data.length > 0) {
            const names = (data as { rep_name: string }[]).map(r => r.rep_name).sort();
            setAllReps(names);
            setSelectedRep(names[0] ?? '');
        }
        setLoadingReps(false);
    }, []);

    useEffect(() => { loadReps(); }, [loadReps]);

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-slate-400 text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">

            {/* ─── Portal header ─── */}
            <div className="bg-white border-b border-slate-100 px-6 md:px-8 pt-6 pb-0">
                <div className="max-w-screen-2xl mx-auto">

                    {/* Rep identity + picker */}
                    <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-brand-main/10 text-brand-main flex items-center justify-center text-lg font-bold border border-brand-main/20 shrink-0">
                                {selectedRep ? selectedRep.charAt(0) : '?'}
                            </div>
                            <div>
                                <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                                    {selectedRep || '—'}
                                </h1>
                                <p className="text-sm text-slate-400">Portail représentant · Vue admin</p>
                            </div>
                        </div>

                        {loadingReps ? (
                            <div className="flex items-center gap-2 text-sm text-slate-400">
                                <Loader2 className="w-4 h-4 animate-spin" /> Chargement des reps...
                            </div>
                        ) : (
                            <RepPicker reps={allReps} selected={selectedRep} onChange={rep => { setSelectedRep(rep); }} />
                        )}
                    </div>

                    {/* Tab bar — same visual as module nav but inline */}
                    <div className="flex items-center gap-1">
                        {TABS.map(tab => {
                            const Icon = tab.icon;
                            const active = activeTab === tab.key;
                            return (
                                <button
                                    key={tab.key}
                                    onClick={() => setActiveTab(tab.key)}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-xl border-b-2 transition-all",
                                        active
                                            ? "border-brand-main text-brand-main bg-brand-main/5"
                                            : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    {tab.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* ─── Tab content ─── */}
            <div className="flex-1 overflow-auto">
                {!selectedRep ? (
                    <div className="flex flex-col items-center justify-center py-24 gap-3">
                        <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center">
                            <User className="w-8 h-8 text-slate-300" />
                        </div>
                        <p className="text-slate-400 font-medium">Sélectionnez un représentant</p>
                    </div>
                ) : (
                    <>
                        {activeTab === 'devis'    && <PortailDevis    propRepName={selectedRep} />}
                        {activeTab === 'factures' && <PortailFactures propRepName={selectedRep} />}
                        {activeTab === 'paye'     && <PortailPaye     propRepName={selectedRep} />}
                    </>
                )}
            </div>
        </div>
    );
}
