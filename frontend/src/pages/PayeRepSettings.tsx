import { Users } from 'lucide-react';
import { useUrlState } from '../hooks/useUrlState';
import { useRepList } from '../hooks/useRepList';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../lib/utils';
import { Select } from '../components/Select';
import PortailPaye from './PortailPaye';

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayeRepSettings() {
    const { isAdmin } = useAuth();
    const repList = useRepList();
    const [selectedRep, setSelectedRep] = useUrlState('rep', '');

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-ink-mute text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto">

            {/* ─── Bordered container: hero + pay table ─── */}
            <div className="rounded-xl border border-primary/20 shadow-card overflow-visible">

                {/* Hero — orange gradient, no overflow-hidden so dropdown shows */}
                <div className="bg-primary rounded-t-xl px-6 py-6 md:py-8">
                    <p className="text-2xs font-semibold text-white uppercase tracking-eyebrow mb-5">
                        Paramètres du représentant
                    </p>

                    <div className="flex flex-col md:flex-row md:items-center gap-5 md:gap-8">

                        {/* Avatar + name */}
                        <div className="flex items-center gap-4 flex-1 min-w-0">
                            <div className={cn(
                                "w-14 h-14 rounded-xl flex items-center justify-center text-2xl font-semibold shrink-0 transition-all",
                                selectedRep
                                    ? "bg-white text-primary-press shadow-lg shadow-black/10"
                                    : "bg-black/15 text-white"
                            )}>
                                {selectedRep ? selectedRep.charAt(0).toUpperCase() : <Users className="w-6 h-6" />}
                            </div>
                            <div className="min-w-0">
                                {selectedRep ? (
                                    <h1 className="text-2xl md:text-3xl font-semibold text-white tracking-tight truncate">
                                        {selectedRep}
                                    </h1>
                                ) : (
                                    <h1 className="text-xl md:text-2xl font-semibold text-white">
                                        Sélectionner un représentant
                                    </h1>
                                )}
                                <p className="text-xs text-white mt-0.5">
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
                <div className="bg-white rounded-b-xl overflow-visible px-4 md:px-6 py-5 md:py-6">
                    {selectedRep ? (
                        <PortailPaye propRepName={selectedRep} embedded />
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <div className="w-12 h-12 rounded-xl bg-stone flex items-center justify-center">
                                <Users className="w-6 h-6 text-ink-faint" />
                            </div>
                            <p className="text-sm text-ink-mute">Sélectionnez un représentant ci-dessus</p>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}
