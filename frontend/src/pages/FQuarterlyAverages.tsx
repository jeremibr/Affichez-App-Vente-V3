import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Loader2 } from 'lucide-react';
import type { YoYRow } from '../types/database';
import { QuarterBlock } from '../components/quarterly/QuarterBlock';
import { OFFICES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { useAuth } from '../contexts/AuthContext';

export default function FQuarterlyAverages() {
    const { isAdmin, repName: authRepName } = useAuth();

    const [year, setYear] = useState<number>(2026);
    const [selectedOffice, setSelectedOffice] = useState<string>('Toutes');
    const [selectedRep, setSelectedRep] = useState<string>(isAdmin ? 'Tous' : (authRepName ?? 'Tous'));
    const [loading, setLoading] = useState(true);
    const [yoyData, setYoyData] = useState<YoYRow[]>([]);

    const repParam = isAdmin ? (selectedRep === 'Tous' ? null : selectedRep) : (authRepName ?? null);

    const uniqueReps = useMemo(() => {
        const reps = new Set<string>();
        yoyData.forEach(row => reps.add(row.rep_name));
        return Array.from(reps).sort((a, b) => a.localeCompare(b));
    }, [yoyData]);

    const fetchAverages = useCallback(async () => {
        setLoading(true);
        const { data, error } = await supabase.rpc('get_inv_quarterly_yoy', {
            p_year: year,
            p_office: selectedOffice === 'Toutes' ? null : selectedOffice,
            p_status: null,
            p_rep: repParam,
        });
        if (error) console.error('Error fetching invoice quarterly averages:', error);
        else setYoyData(data || []);
        setLoading(false);
    }, [year, selectedOffice, repParam]);

    useEffect(() => {
        fetchAverages();
        const channel = supabase.channel('inv-quarterly')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => fetchAverages())
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [fetchAverages]);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const repOptions = useMemo(() => [{ value: 'Tous', label: 'Toute l\'équipe' }, ...uniqueReps.map(r => ({ value: r, label: r }))], [uniqueReps]);
    const yearOptions = [2025, 2026].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
                        Factures — Moyennes Trimestrielles
                        {!isAdmin && authRepName && <span className="ml-2 text-base font-normal text-slate-400">({authRepName})</span>}
                    </h1>
                    <p className="text-sm text-slate-400 mt-0.5">Analyse comparative des factures moyennes par trimestre.</p>
                </div>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(v) => setYear(Number(v))} options={yearOptions} variant="accent" className="w-24" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
                {isAdmin && (
                    <FilterGroup label="Représentant">
                        <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-48" />
                    </FilterGroup>
                )}
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
                    <p className="text-sm text-slate-400 font-medium">Calcul des moyennes...</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    {[1, 2, 3, 4].map((q) => {
                        const dataForQuarter = yoyData
                            .filter(d => d.quarter === q)
                            .filter(d => !isAdmin || selectedRep === 'Tous' || d.rep_name === selectedRep);
                        return (
                            <QuarterBlock key={`q${q}`} quarter={q} data={dataForQuarter} currentYear={year} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}
