import type { ReactNode } from 'react';

interface FilterGroupProps {
    label: string;
    children: ReactNode;
}

export function FilterGroup({ label, children }: FilterGroupProps) {
    return (
        <div className="flex flex-col gap-0.5 md:gap-1 min-w-0">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest px-0.5">
                {label}
            </label>
            {children}
        </div>
    );
}

interface FilterBarProps {
    children: ReactNode;
}

export function FilterBar({ children }: FilterBarProps) {
    return (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-card px-4 md:px-5 py-3 md:py-3.5 grid grid-cols-2 md:flex md:flex-wrap items-end gap-3 md:gap-x-6 md:gap-y-3">
            {children}
        </div>
    );
}
