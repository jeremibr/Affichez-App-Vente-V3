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
] as const;

export const LEAD_SOURCES = [
    { value: 'Meta Ads',                               label: 'Meta Ads' },
    { value: 'Site Web / Recherche Google',            label: 'Site Web / Recherche Google' },
    { value: 'Intérêt par un produit de la boutique', label: 'Boutique' },
    { value: 'A reçu notre publicité imprimé',         label: 'Publicité imprimée' },
    { value: 'Client déjà en CRM du passé',            label: 'Client CRM existant' },
    { value: 'AUTRE (à déterminer dans les notes)',    label: 'Autre' },
] as const;

export const LEAD_SERVICES = [
    { value: 'DISTRIBUTION PUB',          label: 'Distribution pub' },
    { value: 'PROMO',                     label: 'Promo' },
    { value: 'NUMERIQUE',                 label: 'Numérique' },
    { value: 'ÉVÈNEMENT',                 label: 'Événement' },
    { value: 'INTELLIGENCE ARTIFICIELLE', label: 'Intelligence artificielle' },
    { value: 'NON MENTIONNÉ',             label: 'Non mentionné' },
] as const;

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
