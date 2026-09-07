import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadCsv, type CsvColumn } from '../lib/csv';
import { cn } from '../lib/utils';

/**
 * "Exporter CSV" — the same button on every table.
 *
 * `rows` may be a function returning a promise, because the two cases are not
 * the same: a breakdown table already holds everything it shows, while a
 * paginated table holds 100 of 20,645 rows and has to go and fetch the rest.
 * Exporting the visible page would quietly produce a file that answers a
 * different question from the one on screen, so the caller is given somewhere to
 * do the full fetch and the button handles the wait.
 */
export function ExportButton<T>({ rows, columns, filename, label = 'Exporter CSV', className, disabled }: {
    rows: T[] | (() => Promise<T[]>);
    columns: CsvColumn<T>[];
    /** Base name; the helper appends the date and the extension. */
    filename: string;
    label?: string;
    className?: string;
    disabled?: boolean;
}) {
    const [busy, setBusy] = useState(false);

    const handleClick = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const data = typeof rows === 'function' ? await rows() : rows;
            downloadCsv(data, columns, filename);
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={disabled || busy}
            title="Télécharger ces données en CSV (ouvre dans Excel)"
            className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold',
                'border border-slate-200 text-slate-500 bg-white',
                'hover:border-brand-main hover:text-brand-main hover:bg-amber-50/50',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-200',
                'disabled:hover:text-slate-500 disabled:hover:bg-white',
                'transition-colors',
                className,
            )}
        >
            {busy
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />}
            {busy ? 'Préparation…' : label}
        </button>
    );
}
