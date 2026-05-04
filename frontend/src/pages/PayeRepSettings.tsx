import { useState } from 'react';
import { Users } from 'lucide-react';
import { useRepList } from '../hooks/useRepList';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../lib/utils';
import { Select } from '../components/Select';
import PortailPaye from './PortailPaye';

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayeRepSettings() {
    const { isAdmin } = useAuth();
    const repList = useRepList();
    const [selectedRep, setSelectedRep] = useState('');

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-slate-400 text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto">

            {/* ─── Bordered container: hero + pay table ─── */}
            <div className="rounded-2xl border border-brand-main/20 shadow-card overflow-visible">

                {/* Hero — orange gradient, no overflow-hidden so dropdown shows */}
                <div className="bg-gradient-to-br from-brand-main to-amber-600 rounded-t-2xl px-6 py-6 md:py-8">
                    <p className="text-[10px] font-bold text-white/60 uppercase tracking-widest mb-5">
                        Paramètres du représentant
                    </p>

                    <div className="flex flex-col md:flex-row md:items-center gap-5 md:gap-8">

                        {/* Avatar + name */}
                        <div className="flex items-center gap-4 flex-1 min-w-0">
                            <div className={cn(
                                "w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-black shrink-0 transition-all",
                                selectedRep
                                    ? "bg-white text-brand-main shadow-lg shadow-black/10"
                                    : "bg-white/20 text-white/40"
                            )}>
                                {selectedRep ? selectedRep.charAt(0).toUpperCase() : <Users className="w-6 h-6" />}
                            </div>
                            <div className="min-w-0">
                                {selectedRep ? (
                                    <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight truncate">
                                        {selectedRep}
                                    </h1>
                                ) : (
                                    <h1 className="text-xl md:text-2xl font-bold text-white/50">
                                        Sélectionner un représentant
                                    </h1>
                                )}
                                <p className="text-xs text-white/60 mt-0.5">
                                    {selectedRep
                                        ? 'Toutes les données ci-dessous correspondent à ce représentant'
                                        : 'Choisissez un représentant pour voir et modifier sa paye'}
                                </p>
                            </div>
                        </div>

                        {/* Rep dropdown */}
                        <div className="w-full md:w-64 shrink-0">
                            <Select
                                value={selectedRep}
                                onChange={setSelectedRep}
                                options={[
                                    { value: '', label: selectedRep ? 'Changer de représentant...' : 'Choisir un représentant...' },
                                    ...repList.map(r => ({ value: r, label: r })),
                                ]}
                                variant={selectedRep ? 'accent' : 'default'}
                                className="w-full"
                            />
                        </div>
                    </div>
                </div>

                {/* Pay table */}
                <div className="bg-white rounded-b-2xl overflow-visible px-4 md:px-6 py-5 md:py-6">
                    {selectedRep ? (
                        <PortailPaye propRepName={selectedRep} embedded />
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center">
                                <Users className="w-6 h-6 text-slate-300" />
                            </div>
                            <p className="text-sm text-slate-400">Sélectionnez un représentant ci-dessus</p>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}
