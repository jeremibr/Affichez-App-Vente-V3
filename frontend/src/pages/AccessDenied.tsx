import { useState } from 'react';
import { Loader2, LogOut, RefreshCcw } from 'lucide-react';
import { Logo } from '../components/Logo';
import { useAuth } from '../contexts/AuthContext';

/**
 * Shown instead of the app to someone who is signed in but cannot use it.
 *
 *   denied   the address is not in the user list;
 *   empty    it is listed, but no section has been ticked for it;
 *   error    the list could not be read, so nothing is known either way.
 *
 * The session is left alone - the database returns nothing to an unlisted
 * address anyway - and the way out is offered explicitly.
 */
type Reason = 'denied' | 'empty' | 'error';

const COPY: Record<Reason, { title: string; body: string }> = {
    denied: {
        title: 'Accès non autorisé',
        body: 'Cette adresse ne fait pas partie des utilisateurs de l’application. '
            + 'Demandez à un administrateur de vous ajouter dans Paramètres → Utilisateurs.',
    },
    empty: {
        title: 'Aucune section attribuée',
        body: 'Votre compte est bien enregistré, mais aucune section ne lui est encore ouverte. '
            + 'Demandez à un administrateur de cocher celles dont vous avez besoin.',
    },
    error: {
        title: 'Accès non vérifié',
        body: 'Vos accès n’ont pas pu être vérifiés. Vérifiez votre connexion, puis réessayez.',
    },
};

export default function AccessDenied({ reason }: { reason: Reason }) {
    const { user, signOut, refreshAccess } = useAuth();
    const [busy, setBusy] = useState(false);
    const { title, body } = COPY[reason];

    const retry = async () => {
        setBusy(true);
        await refreshAccess();
        setBusy(false);
    };

    return (
        <div className="min-h-screen bg-sand flex items-center justify-center p-4">
            <div className="w-full max-w-sm">
                <div className="flex justify-center mb-8">
                    <Logo height={28} />
                </div>

                <div className="bg-white rounded-xl shadow-card p-8">
                    <h1 className="text-xl font-semibold text-ink tracking-tight">{title}</h1>
                    <p className="text-sm text-ink-mute mt-2 leading-relaxed">{body}</p>

                    {user?.email && (
                        <p className="mt-4 text-xs text-ink-secondary bg-sand rounded-md px-3 py-2 truncate" translate="no">
                            {user.email}
                        </p>
                    )}

                    <div className="mt-6 flex flex-col gap-2">
                        {reason !== 'denied' && (
                            <button onClick={retry} disabled={busy} className="btn btn-md btn-primary w-full">
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
                                Réessayer
                            </button>
                        )}
                        <button onClick={signOut} className="btn btn-md btn-secondary w-full">
                            <LogOut className="w-4 h-4" /> Se déconnecter
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
