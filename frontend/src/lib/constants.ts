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
