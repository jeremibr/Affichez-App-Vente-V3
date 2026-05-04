import { useState, useEffect } from 'react';
import { useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Save, RefreshCcw, Target } from 'lucide-react';
import { Select } from '../components/Select';
import { DEPARTMENTS, MONTHS } from '../lib/constants';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../lib/utils';

interface Objective { id: string; year: number; month: number; department: string; target_amount: number; }

export default function ObjectifsEquipe() {
    const { isAdmin } = useAuth();
    const [year, setYear] = useUrlStateNumber('obj_year', new Date().getFullYear());
    const [objectives, setObjectives] = useState<Objective[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => { fetchObjectives(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

    const fetchObjectives = async () => {
        setLoading(true);
        const { data, error } = await supabase
            .from('objectives_factures')
            .select('*')
            .eq('year', year);
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
        const { error: delError } = await supabase.from('objectives_factures').delete().eq('year', year);
        if (delError) { setSaving(false); return; }
        const { error: insError } = await supabase.from('objectives_factures').insert(toSave);
        if (!insError) { setSaved(true); setTimeout(() => setSaved(false), 3000); fetchObjectives(); }
        setSaving(false);
    };

    const yearOptions = [2024, 2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-slate-400 text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-xl mx-auto space-y-6">

            {/* Header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2.5 mb-1">
                        <div className="p-2 rounded-xl bg-brand-main/10">
                            <Target className="w-4 h-4 text-brand-main" />
                        </div>
                        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Objectifs Équipe</h1>
                    </div>
                    <p className="text-sm text-slate-400">Cibles mensuelles de facturation par département · {year}</p>
                </div>

                <div className="flex items-center gap-3">
                    <Select
                        value={String(year)}
                        onChange={v => setYear(Number(v))}
                        options={yearOptions}
                        variant="accent"
                        className="w-24"
                    />
                    <button
                        onClick={saveAll}
                        disabled={saving}
                        className={cn(
                            "flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold shadow-sm transition-all disabled:opacity-50",
                            saved
                                ? "bg-emerald-500 text-white shadow-emerald-200"
                                : "bg-brand-main text-white shadow-brand-main/30 hover:bg-brand-main/90"
                        )}
                    >
                        {saving
                            ? <RefreshCcw className="w-4 h-4 animate-spin" />
                            : <Save className="w-4 h-4" />}
                        {saved ? 'Sauvegardé !' : 'Enregistrer'}
                    </button>
                </div>
            </div>

            {/* Grid */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                    <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/60">
                            <th className="px-5 py-3.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest sticky left-0 bg-slate-50/60">
                                Mois
                            </th>
                            {DEPARTMENTS.map(dept => (
                                <th key={dept} className="px-4 py-3.5 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                                    {dept.length > 15 ? dept.substring(0, 13) + '…' : dept}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {loading ? (
                            <tr>
                                <td colSpan={DEPARTMENTS.length + 1} className="px-5 py-12 text-center text-slate-400 italic text-sm">
                                    Chargement...
                                </td>
                            </tr>
                        ) : MONTHS.map(month => {
                            const monthNum = month.value;
                            return (
                                <tr key={monthNum} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-5 py-2.5 font-semibold text-slate-700 sticky left-0 bg-white whitespace-nowrap">
                                        {month.label}
                                    </td>
                                    {DEPARTMENTS.map(dept => {
                                        const obj = objectives.find(o => o.month === monthNum && o.department === dept);
                                        return (
                                            <td key={dept} className="px-3 py-2">
                                                <input
                                                    type="number"
                                                    className="w-full bg-slate-50 border-0 rounded-lg px-3 py-2 text-right text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-main/30 focus:bg-white transition-all tabular-nums"
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

            <p className="text-xs text-slate-400 px-1">
                Montants avant taxes · Cliquez sur Enregistrer après chaque modification.
            </p>
        </div>
    );
}
