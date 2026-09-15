import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ZoneB_DetailRow, ZoneA_DeptTotal } from '../types/database';

// The brand palette, as RGB triples because jsPDF takes no hex. These mirror
// branding/tokens/tokens.css - change them there first, then here.
const BRAND_ORANGE: [number, number, number] = [245, 87, 14];    // --color-primary
const BLACK: [number, number, number] = [0, 0, 0];               // --color-ink
const INK_SECONDARY: [number, number, number] = [61, 61, 59];    // --color-ink-secondary
const INK_MUTE: [number, number, number] = [107, 107, 104];      // --color-ink-mute
const WHITE: [number, number, number] = [255, 255, 255];
const LIGHT_BG: [number, number, number] = [243, 243, 241];      // --color-sand
const TABLE_HEAD_BG: [number, number, number] = [231, 230, 226]; // --color-stone
const HAIRLINE: [number, number, number] = [212, 211, 206];      // --color-hairline-strong


function fmtCAD(n: number): string {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(n).replace('CA', '').trim();
}

function fmtDate(d: string): string {
    if (!d) return '';
    const [y, m, day] = d.split('-').map(Number);
    const date = new Date(y, m - 1, day);
    return date.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface WeeklyPdfData {
    weekStart: string;
    weekEnd: string;
    grandTotal: number;
    avgTicket: number;
    devisCount: number;
    repPivotRows: { repName: string; [key: string]: string | number }[];
    deptTotals: ZoneA_DeptTotal[];
    lineItems: ZoneB_DetailRow[];
    filters: { office: string; status: string; dept: string; rep: string };
}

export async function generateWeeklyPdf(data: WeeklyPdfData): Promise<void> {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 14;
    let y = margin;

    // ─── Load logo ───
    let logo: { dataUrl: string; ratio: number } | null = null;
    try {
        logo = await loadWordmark();
    } catch { /* no logo, continue without */ }

    // ─── Helper: add page footer ───
    const addFooter = () => {
        const footerY = pageH - 8;
        doc.setFillColor(...LIGHT_BG);
        doc.rect(0, footerY - 2, pageW, 10, 'F');
        doc.setFontSize(7);
        doc.setTextColor(...INK_MUTE);
        doc.text(`Affichez · Rapport hebdomadaire du ${fmtDate(data.weekStart)} au ${fmtDate(data.weekEnd)}`, margin, footerY + 2);
        doc.text(`Généré le ${new Date().toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' })}`, pageW - margin, footerY + 2, { align: 'right' });
    };

    // ─── HEADER BAR ───
    doc.setFillColor(...LIGHT_BG);
    doc.rect(0, 0, pageW, 28, 'F');
    // Orange accent line under header
    doc.setFillColor(...BRAND_ORANGE);
    doc.rect(0, 28, pageW, 1, 'F');

    if (logo) {
        const logoH = 12;
        doc.addImage(logo.dataUrl, 'PNG', margin, 8, logoH * logo.ratio, logoH);
    } else {
        // The 2026 wordmark is lowercase; helvetica is the closest face jsPDF
        // ships, and this only ever runs if the PNG failed to load.
        doc.setFontSize(16);
        doc.setTextColor(...BRAND_ORANGE);
        doc.setFont('helvetica', 'bold');
        doc.text('affichez', margin, 18);
    }

    doc.setFontSize(14);
    doc.setTextColor(...BLACK);
    doc.setFont('helvetica', 'bold');
    doc.text('Rapport Hebdomadaire', pageW - margin, 12, { align: 'right' });
    doc.setFontSize(10);
    doc.setTextColor(...BRAND_ORANGE);
    doc.text(`${fmtDate(data.weekStart)} au ${fmtDate(data.weekEnd)}`, pageW - margin, 20, { align: 'right' });

    y = 36;

    // ─── ACTIVE FILTERS LINE (if any) ───
    const activeFilters: string[] = [];
    if (data.filters.office !== 'Toutes') activeFilters.push(`Siège: ${data.filters.office}`);
    if (data.filters.status !== 'Toutes') activeFilters.push(`Statut: ${data.filters.status}`);
    if (data.filters.dept !== 'Toutes') activeFilters.push(`Dept: ${data.filters.dept}`);
    if (data.filters.rep !== 'Tous') activeFilters.push(`Rep: ${data.filters.rep}`);
    if (activeFilters.length > 0) {
        doc.setFontSize(7);
        doc.setTextColor(...INK_MUTE);
        doc.text(`Filtres: ${activeFilters.join('  |  ')}`, margin, y);
        y += 6;
    }

    // ─── KPI CARDS ───
    const kpiW = (pageW - margin * 2 - 8) / 3;
    const kpiH = 22;

    // Card 1: Total
    drawKpiCard(doc, margin, y, kpiW, kpiH, 'Total Hebdomadaire', fmtCAD(data.grandTotal), true);
    // Card 2: Vente Moyenne
    drawKpiCard(doc, margin + kpiW + 4, y, kpiW, kpiH, 'Vente Moyenne', fmtCAD(data.avgTicket), false);
    // Card 3: Volume
    drawKpiCard(doc, margin + (kpiW + 4) * 2, y, kpiW, kpiH, "Volume d'affaires", `${data.devisCount} Devis`, false);

    y += kpiH + 8;

    // ─── LEADERBOARD TABLE ───
    doc.setFontSize(10);
    doc.setTextColor(...BLACK);
    doc.setFont('helvetica', 'bold');
    doc.text('Leaderboard de la semaine', margin, y + 1);
    y += 4;

    // Build leaderboard from lineItems
    const repTotals = new Map<string, { amount: number; count: number }>();
    data.lineItems.forEach(item => {
        const prev = repTotals.get(item.rep_name) || { amount: 0, count: 0 };
        prev.amount += Number(item.amount);
        prev.count += 1;
        repTotals.set(item.rep_name, prev);
    });
    const leaderboard = Array.from(repTotals.entries())
        .map(([name, { amount, count }]) => ({ name, amount, count, avg: amount / count }))
        .sort((a, b) => b.amount - a.amount);

    autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['#', 'Représentant', 'Total', 'Devis', 'Moy./devis']],
        body: leaderboard.map((rep, i) => [
            String(i + 1),
            rep.name,
            fmtCAD(rep.amount),
            String(rep.count),
            fmtCAD(rep.avg),
        ]),
        headStyles: {
            fillColor: TABLE_HEAD_BG,
            textColor: BLACK,
            fontSize: 7,
            fontStyle: 'bold',
            cellPadding: 2,
        },
        bodyStyles: {
            fontSize: 7,
            cellPadding: 2,
            textColor: INK_SECONDARY,
        },
        alternateRowStyles: { fillColor: LIGHT_BG },
        columnStyles: {
            0: { cellWidth: 10, halign: 'center', fontStyle: 'bold', textColor: INK_MUTE },
            2: { halign: 'right', fontStyle: 'bold', textColor: BLACK },
            3: { halign: 'right', fontStyle: 'bold' },
            4: { halign: 'right', textColor: INK_MUTE },
        },
        didParseCell: (hookData) => {
            // Gold highlight for #1
            if (hookData.section === 'body' && hookData.row.index === 0 && hookData.column.index === 0) {
                hookData.cell.styles.textColor = BRAND_ORANGE;
                hookData.cell.styles.fontStyle = 'bold';
            }
        },
        tableWidth: pageW - margin * 2,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;

    // ─── DEPARTMENT BREAKDOWN (inline) ───
    if (data.deptTotals.length > 0) {
        doc.setFontSize(10);
        doc.setTextColor(...BLACK);
        doc.setFont('helvetica', 'bold');
        doc.text('Répartition par département', margin, y + 1);
        y += 4;

        autoTable(doc, {
            startY: y,
            margin: { left: margin, right: margin },
            head: [['Département', 'Total', 'Devis']],
            body: data.deptTotals
                .sort((a, b) => b.total_amount - a.total_amount)
                .map(d => [d.department, fmtCAD(d.total_amount), String(d.num_sales)]),
            foot: [['Total', fmtCAD(data.grandTotal), String(data.devisCount)]],
            headStyles: { fillColor: TABLE_HEAD_BG, textColor: BLACK, fontSize: 7, fontStyle: 'bold', cellPadding: 2 },
            bodyStyles: { fontSize: 7, cellPadding: 2, textColor: INK_SECONDARY },
            footStyles: { fillColor: BLACK, textColor: WHITE, fontSize: 7, fontStyle: 'bold', cellPadding: 2 },
            alternateRowStyles: { fillColor: LIGHT_BG },
            columnStyles: {
                1: { halign: 'right', fontStyle: 'bold' },
                2: { halign: 'right' },
            },
            tableWidth: pageW - margin * 2,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        y = (doc as any).lastAutoTable.finalY + 8;
    }

    // ─── Check if we need a new page for the detail table ───
    if (y > pageH - 50) {
        addFooter();
        doc.addPage();
        y = margin;
    }

    // ─── DETAILED QUOTES TABLE ───
    doc.setFontSize(10);
    doc.setTextColor(...BLACK);
    doc.setFont('helvetica', 'bold');
    doc.text('Liste détaillée des devis', margin, y + 1);
    y += 4;

    const sortedItems = [...data.lineItems].sort((a, b) => b.amount - a.amount);

    autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Date', 'Client', 'Montant', '# Devis', 'Représentant', 'Département', 'Statut']],
        body: sortedItems.map(item => [
            fmtDate(item.sale_date),
            item.client_name,
            fmtCAD(item.amount),
            item.quote_number,
            item.rep_name,
            item.department,
            item.status === 'invoiced' ? 'Facturé' : 'Accepté',
        ]),
        foot: [[
            '',
            'Total hebdomadaire',
            fmtCAD(data.grandTotal),
            `${data.devisCount} devis`,
            '',
            '',
            '',
        ]],
        headStyles: {
            fillColor: TABLE_HEAD_BG,
            textColor: BLACK,
            fontSize: 6.5,
            fontStyle: 'bold',
            cellPadding: 2,
        },
        bodyStyles: {
            fontSize: 6.5,
            cellPadding: 1.8,
            textColor: INK_SECONDARY,
        },
        footStyles: {
            // A total row is a band, and the brand's band colour is black.
            fillColor: BLACK,
            textColor: WHITE,
            fontSize: 7,
            fontStyle: 'bold',
            cellPadding: 2,
        },
        alternateRowStyles: { fillColor: LIGHT_BG },
        columnStyles: {
            0: { cellWidth: 24 },
            1: { cellWidth: 60 },
            2: { halign: 'right', fontStyle: 'bold', textColor: BLACK },
            3: { cellWidth: 28, fontSize: 5.5, textColor: INK_MUTE },
            4: { cellWidth: 32 },
            5: { cellWidth: 32, fontSize: 5.5 },
            6: { cellWidth: 16, halign: 'center', fontSize: 5.5 },
        },
        tableWidth: pageW - margin * 2,
    });

    // ─── Add footer to all pages ───
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        addFooter();
    }

    // ─── Save ───
    const fileName = `Affichez_Hebdo_${data.weekStart}_${data.weekEnd}.pdf`;
    doc.save(fileName);
}

function drawKpiCard(
    doc: jsPDF, x: number, y: number, w: number, h: number,
    label: string, value: string, isPrimary: boolean
) {
    if (isPrimary) {
        doc.setFillColor(...BRAND_ORANGE);
        doc.roundedRect(x, y, w, h, 3, 3, 'F');
        doc.setFontSize(7);
        doc.setTextColor(...WHITE);
        doc.setFont('helvetica', 'bold');
        doc.text(label.toUpperCase(), x + 5, y + 7);
        doc.setFontSize(14);
        doc.text(value, x + 5, y + 17);
    } else {
        doc.setFillColor(...WHITE);
        doc.setDrawColor(...HAIRLINE);
        doc.roundedRect(x, y, w, h, 3, 3, 'FD');
        doc.setFontSize(7);
        doc.setTextColor(...INK_MUTE);
        doc.setFont('helvetica', 'bold');
        doc.text(label.toUpperCase(), x + 5, y + 7);
        doc.setFontSize(14);
        doc.setTextColor(...BLACK);
        doc.text(value, x + 5, y + 17);
    }
}

/**
 * The wordmark, rasterised from its own SVG at export time.
 *
 * jsPDF can only place a raster, and the brand ships the logo as a vector with
 * a viewBox but no intrinsic width or height - hand that straight to an
 * <img> and the browser falls back to 300x150, which squashes a 4.83:1 mark.
 * So the size is set explicitly here and the SVG is drawn onto a canvas at 3x
 * the largest size the PDF uses, which keeps it crisp when the report is
 * printed rather than read on screen.
 *
 * Doing it this way means the PNG in the report and the logo in the sidebar
 * are the same file - there is no second copy to forget to update.
 */
const WORDMARK_RATIO = 3516.375 / 727.446;   // the brand SVG's own viewBox

async function loadWordmark(): Promise<{ dataUrl: string; ratio: number }> {
    const svg = await fetch('/brand/affichez-logo.svg').then(r => {
        if (!r.ok) throw new Error(`logo ${r.status}`);
        return r.text();
    });
    const height = 300;
    const width = Math.round(height * WORDMARK_RATIO);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
        const img = new Image();
        img.width = width;
        img.height = height;
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('logo decode failed'));
            img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(img, 0, 0, width, height);
        return { dataUrl: canvas.toDataURL('image/png'), ratio: WORDMARK_RATIO };
    } finally {
        URL.revokeObjectURL(url);
    }
}
