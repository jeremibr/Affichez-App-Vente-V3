import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Loader2 } from 'lucide-react';
import { SyncButton } from '../components/SyncButton';
import type { YoYRow } from '../types/database';
import { QuarterBlock } from '../components/quarterly/QuarterBlock';
import { OFFICES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';

export default function QuarterlyAverages() {
    const [year, setYear] = useState<number>(2026);
    const [selectedRep, setSelectedRep] = useState<string>('Tous');
    const [selectedOffice, setSelectedOffice] = useState<string>('Toutes');
    const [loading, setLoading] = useState(true);
    const [yoyData, setYoyData] = useState<YoYRow[]>([]);

    const uniqueReps = useMemo(() => {
        const reps = new Set<string>();
        yoyData.forEach(row => reps.add(row.rep_name));
        return Array.from(reps).sort((a, b) => a.localeCompare(b));
    }, [yoyData]);

    const fetchAverages = useCallback(async () => {
        setLoading(true);
        const { data, error } = await supabase.rpc('get_quarterly_yoy', {
            p_year: year,
            p_office: selectedOffice === 'Toutes' ? null : selectedOffice,
            p_status: null
        });
        if (error) console.error("Error fetching quarterly averages:", error);
        else setYoyData(data || []);
        setLoading(false);
    }, [year, selectedOffice]);

    useEffect(() => {
        fetchAverages();
        const channel = supabase.channel('quarterly-sales')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => fetchAverages())
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [fetchAverages]);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const repOptions = useMemo(() => [{ value: 'Tous', label: 'Toute l\'équipe' }, ...uniqueReps.map(r => ({ value: r, label: r }))], [uniqueReps]);
    const yearOptions = [2025, 2026].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="p-6 md:p-8 max-w-screen-2xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Moyennes Trimestrielles</h1>
                    <p className="text-sm text-slate-400 mt-0.5">Analyse comparative des performances moyennes par trimestre.</p>
                </div>
                <SyncButton onSyncComplete={fetchAverages} />
            </div>

            {/* Filters */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(v) => setYear(Number(v))} options={yearOptions} variant="accent" className="w-24" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-48" />
                </FilterGroup>
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
                            .filter(d => selectedRep === 'Tous' || d.rep_name === selectedRep);
                        return (
                            <QuarterBlock key={`q${q}`} quarter={q} data={dataForQuarter} currentYear={year} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}
