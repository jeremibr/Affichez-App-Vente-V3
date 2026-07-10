export type SommaireRow = {
    month: number;
    department?: string;
    objectif: number;
    actual_amount: number;
    pct_atteint: number;
    deal_count: number;
};

export type AvailableWeek = {
    week_start: string;
    week_end: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneA_SummaryRow = {
    week_start: string;
    week_end: string;
    rep_name: string;
    office: string;
    status: string;
    department: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneA_DeptTotal = {
    department: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneB_DetailRow = {
    sale_date: string;
    client_name: string;
    amount: number;
    quote_number: string;
    rep_name: string;
    department: string;
    zoho_department_label: string;
    office: 'QC' | 'MTL';
    status: 'accepted' | 'invoiced' | 'declined';
    zoho_id: string;
};

export type YoYRow = {
    quarter: number;
    rep_name: string;
    office: string;
    current_avg: number;
    previous_avg: number;
    resultat: number;
    deal_count: number;
};

// True per-quarter team totals (all reps active in each year), from
// get_quarterly_yoy_totals / get_inv_quarterly_yoy_totals. Used to show the real
// last-year comparison in the "Total équipe" row instead of only summing reps
// active in the current year.
export type QuarterTotalsRow = {
    quarter: number;
    current_total: number;
    previous_total: number;
};

export type InvDetailRow = {
    invoice_date: string;
    client_name: string;
    amount: number;
    invoice_number: string;
    rep_name: string;
    department: string;
    zoho_department_label: string;
    office: 'QC' | 'MTL';
    status: 'sent' | 'viewed' | 'paid' | 'partial' | 'overdue' | 'void' | 'avoir';
    is_avoir: boolean;
    zoho_id: string;
};

export type LeadRow = {
    id: string;
    created_at: string;
    lead_date: string;
    rep_name: string;
    source: string;
    service_interest: string | null;
    amount_sold: number;
    zoho_lead_id: string | null;
    zoho_contact_id: string | null;
    zoho_crm_url: string | null;
    notes: string | null;
    lead_status: 'active' | 'won' | 'lost';
};

export type LeadKPIs = {
    total_leads: number;
    won_leads: number;
    conversion_rate: number;
    total_amount: number;
};

export type LeadsByRepRow = {
    rep_name: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsBySourceRow = {
    source: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsByServiceRow = {
    service_interest: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsMonthlySummaryRow = {
    month: number;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

// ─── Tâches CRM (Zoho CRM tasks) ────────────────────────────────────────────

export type TaskKPIs = {
    total_created: number;
    total_completed: number;
    completion_rate: number;
    total_touched: number;
    total_open: number;
    total_overdue: number;
    active_reps: number;
};

export type TasksByRepRow = {
    rep_name: string;
    nb_created: number;
    nb_completed: number;
    nb_touched: number;
    completion_rate: number;
    avg_days_to_close: number | null;
    nb_open: number;
    nb_overdue: number;
};

export type TasksByStatusRow = {
    status: string;
    nb: number;
};

export type TasksWeeklyRow = {
    week_start: string;
    nb_created: number;
    nb_completed: number;
};

export type TasksWoWRow = {
    rep_name: string;
    created_this_week: number;
    created_last_week: number;
    completed_this_week: number;
    completed_last_week: number;
};

export type TasksAvailableWeek = {
    week_start: string;
    week_end: string;
    nb_created: number;
    nb_completed: number;
};
