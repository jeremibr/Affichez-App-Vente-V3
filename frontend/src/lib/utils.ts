import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format } from "date-fns";
import { frCA } from "date-fns/locale";

// Tailwind class merger
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// ─── Canadian French Currency Formatter (CAD) ───
// Rules: '1 287 016,80 $', space as thousands separator, comma for decimals, $ after
// The native Intl.NumberFormat for fr-CA gets very close to this automatically.
export function formatCurrencyCAD(amount: number): string {
    // Use Intl.NumberFormat to handle the heavy lifting
    const formatter = new Intl.NumberFormat('fr-CA', {
        style: 'currency',
        currency: 'CAD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

    // Intl format string looks like "1 234,56 $"
    // Some browsers might output "1 234,56 $ CA" or encode non-breaking spaces.
    let formatted = formatter.format(amount);

    // Clean up standard Canadian output if 'CA' is appended
    if (formatted.includes('CA')) {
        formatted = formatted.replace('CA', '').trim();
    }

    return formatted;
}

// ─── Canadian French Date Formatter ───
// Long format: '16 février 2026'
export function formatLongDate(dateString: string | Date): string {
    let date: Date;
    if (typeof dateString === 'string' && dateString.length === 10 && dateString.includes('-')) {
        const [year, month, day] = dateString.split('-').map(Number);
        date = new Date(year, month - 1, day);
    } else {
        date = typeof dateString === 'string' ? new Date(dateString) : dateString;
    }
    return format(date, 'd MMMM yyyy', { locale: frCA });
}

// Short format: '16 févr. 2026'
export function formatShortDate(dateString: string | Date): string {
    let date: Date;
    if (typeof dateString === 'string' && dateString.length === 10 && dateString.includes('-')) {
        const [year, month, day] = dateString.split('-').map(Number);
        date = new Date(year, month - 1, day);
    } else {
        date = typeof dateString === 'string' ? new Date(dateString) : dateString;
    }
    return format(date, 'd MMM yyyy', { locale: frCA });
}

export function formatPercentage(value: number): string {
    const formatter = new Intl.NumberFormat('fr-CA', {
        style: 'percent',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    // value expected as decimal for Intl, but DB returns % like 89.04.
    // We divide by 100 since Intl expects 0.8904
    return formatter.format(value / 100);
}
