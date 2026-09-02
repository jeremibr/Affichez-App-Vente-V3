export const DEPARTMENTS = [
    'MULTI-ANNONCEURS',
    'PROMOTIONNEL',
    'DIST. PUBLICITAIRE SOLO',
    'NUMERIQUE',
    'APPLICATION',
    'SERVICES IA'
] as const;

export const MONTHS = [
    { value: 1, label: 'Janvier' },
    { value: 2, label: 'Février' },
    { value: 3, label: 'Mars' },
    { value: 4, label: 'Avril' },
    { value: 5, label: 'Mai' },
    { value: 6, label: 'Juin' },
    { value: 7, label: 'Juillet' },
    { value: 8, label: 'Août' },
    { value: 9, label: 'Septembre' },
    { value: 10, label: 'Octobre' },
    { value: 11, label: 'Novembre' },
    { value: 12, label: 'Décembre' }
] as const;
export const OFFICES = [
    { value: 'QC', label: 'Québec' },
    { value: 'MTL', label: 'Montréal' }
] as const;

export const SALE_STATUSES = [
    { value: 'accepted', label: 'Accepté' },
    { value: 'invoiced', label: 'Facturé' }
] as const;

export const INVOICE_STATUSES = [
    { value: 'paid',     label: 'Payé' },
    { value: 'partial',  label: 'Partiel' },
    { value: 'sent',     label: 'Envoyé' },
    { value: 'overdue',  label: 'En retard' },
    { value: 'avoir',    label: 'Avoir (crédit)' },
] as const;

export const INTERNAL_REP_NAMES = [
    'Simon Fortin Massé',
    'Magasin Affichez',
    'Charles Côté',
    'Pier-Alexandre Lévesque',
    'Vente interne',
    'Vincent Dagenais',
] as const;

// LEAD_SOURCES / LEAD_SERVICES used to live here. They were the legacy `leads`
// table's vocabulary, and only one of the six sources ("Meta Ads") exists in
// Zoho CRM at all — the real top source, "Publicité/Recherche Google", was
// never offered. Filter options now come from the data itself, via the
// get_zoho_lead_filter_options RPC, which also folds Zoho's case variants.

export const LEAD_STATUSES = [
    { value: 'active', label: 'Actif' },
    { value: 'won',    label: 'Vendu' },
    { value: 'lost',   label: 'Perdu' },
] as const;

// Zoho CRM Task statuses — the real French picklist values from this org's CRM.
// (value = raw Zoho value stored in zoho_tasks.status; completion itself is derived
// from closed_time, so these are only used for the filter dropdown + labels/colors.)
export const TASK_STATUSES = [
    { value: 'Non commencé', label: 'Non commencé' },
    { value: 'En cours',     label: 'En cours' },
    { value: 'Achevé',       label: 'Achevé' },
] as const;

// Zoho CRM Task priorities — the real French values from this org's CRM
// ('Normal' and 'Normale' both occur in the data).
export const TASK_PRIORITIES = [
    { value: 'Top Prioritaire', label: 'Top prioritaire' },
    { value: 'Haute',           label: 'Haute' },
    { value: 'Normale',         label: 'Normale' },
    { value: 'Normal',          label: 'Normale' },
    { value: 'Basse',           label: 'Basse' },
    { value: 'Très basse',      label: 'Très basse' },
] as const;
