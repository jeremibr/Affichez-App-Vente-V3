import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../lib/utils';

export interface SelectOption {
    value: string;
    label: string;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    variant?: 'default' | 'accent';
    disabled?: boolean;
    placeholder?: string;
    className?: string;
}

export function Select({
    value,
    onChange,
    options,
    variant = 'default',
    disabled = false,
    className,
}: SelectProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const selected = options.find(o => o.value === value);

    const close = useCallback(() => setOpen(false), []);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                close();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open, close]);

    // Keyboard: Escape to close
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, close]);

    const handleSelect = (val: string) => {
        onChange(val);
        close();
    };

    const isAccent = variant === 'accent';

    return (
        <div ref={containerRef} className={cn("relative", className)}>
            {/* Trigger */}
            <button
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setOpen(o => !o)}
                className={cn(
                    "flex items-center gap-2 w-full pl-3 pr-2.5 py-2 rounded-lg text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-brand-main/25 select-none",
                    disabled && "opacity-40 cursor-not-allowed",
                    isAccent
                        ? "bg-amber-50 text-brand-main hover:bg-amber-100"
                        : "bg-slate-50 text-slate-700 hover:bg-slate-100",
                    open && (isAccent ? "bg-amber-100 ring-2 ring-brand-main/25" : "bg-slate-100 ring-2 ring-slate-200")
                )}
            >
                <span className="flex-1 text-left truncate">{selected?.label ?? '—'}</span>
                <ChevronDown className={cn(
                    "w-3.5 h-3.5 shrink-0 transition-transform duration-150",
                    isAccent ? "text-brand-main" : "text-slate-400",
                    open && "rotate-180"
                )} />
            </button>

            {/* Dropdown */}
            {open && (
                <div className={cn(
                    "absolute z-50 top-full mt-1.5 left-0 min-w-full bg-white rounded-xl border border-slate-100 shadow-xl shadow-slate-900/10 overflow-hidden",
                    "animate-in fade-in slide-in-from-top-2 duration-100"
                )}>
                    <div className="py-1 max-h-64 overflow-y-auto">
                        {options.map(opt => {
                            const isSelected = opt.value === value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => handleSelect(opt.value)}
                                    className={cn(
                                        "w-full flex items-center justify-between gap-3 px-3 py-2 text-sm transition-colors text-left",
                                        isSelected
                                            ? "bg-brand-main/5 text-brand-main font-semibold"
                                            : "text-slate-700 hover:bg-slate-50 font-medium"
                                    )}
                                >
                                    <span>{opt.label}</span>
                                    {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-brand-main" />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
