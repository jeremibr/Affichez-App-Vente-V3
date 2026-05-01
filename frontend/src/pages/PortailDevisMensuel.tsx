import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { MonthlyDetail } from '../components/monthly/MonthlyDetail';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { fetchCommRate } from '../utils/commRates';

interface Props { propRepName?: string; }

export default function PortailDevisMensuel({ propRepName }: Props) {
    const { repName: authRepName } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';
    const [commRate, setCommRate] = useState(0.05);

    useEffect(() => {
        if (!repName) return;
        fetchCommRate(repName).then(setCommRate);
    }, [repName]);

    return (
        <div className="p-6 md:p-8 max-w-screen-2xl mx-auto space-y-6">
            <div>
                <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                    <ClipboardList className="w-5 h-5 text-blue-400" />
                    Mes Devis — Détail Mensuel
                </h2>
                <p className="text-sm text-slate-400 mt-0.5">
                    Ventes mois par mois · {repName || 'Représentant'}
                </p>
            </div>

            <MonthlyDetail
                module="devis"
                repName={repName || null}
                commRate={commRate}
            />
        </div>
    );
}
