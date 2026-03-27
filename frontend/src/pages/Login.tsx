import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

const ZOHO_CLIENT_ID = import.meta.env.VITE_ZOHO_CLIENT_ID as string;
const SUPABASE_URL   = import.meta.env.VITE_SUPABASE_URL as string;
const REDIRECT_URI   = `${SUPABASE_URL}/functions/v1/zoho-auth`;

const ERROR_MESSAGES: Record<string, string> = {
    denied:         "Connexion annulée.",
    not_authorized: "Votre compte n'est pas autorisé. Contactez l'administrateur.",
    token_failed:   "Erreur d'authentification Zoho. Réessayez.",
    no_email:       "Impossible de récupérer votre courriel Zoho.",
    session_failed: "Erreur lors de la création de session. Réessayez.",
    server_error:   "Erreur serveur. Réessayez dans un moment.",
};

export default function Login() {
    const [loading, setLoading]  = useState(false);
    const [searchParams]         = useSearchParams();
    const authError              = searchParams.get('auth_error');

    useEffect(() => {
        if (authError) window.history.replaceState({}, '', window.location.pathname);
    }, [authError]);

    const handleZohoLogin = () => {
        setLoading(true);
        const params = new URLSearchParams({
            client_id:     ZOHO_CLIENT_ID,
            response_type: 'code',
            scope:         'openid email profile',
            redirect_uri:  REDIRECT_URI,
            access_type:   'online',
            prompt:        'consent',
        });
        window.location.href = `https://accounts.zoho.com/oauth/v2/auth?${params}`;
    };

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm">

                <div className="flex justify-center mb-8">
                    <img src="/logo-long.png" alt="Affichez" className="h-9 w-auto object-contain" />
                </div>

                <div className="bg-white rounded-2xl border border-slate-100 shadow-lg shadow-slate-200/60 p-8">
                    <div className="mb-7">
                        <h1 className="text-xl font-bold text-slate-900">Bon retour</h1>
                        <p className="text-sm text-slate-400 mt-1">Connectez-vous avec votre compte Zoho.</p>
                    </div>

                    {authError && (
                        <div className="mb-5 text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                            {ERROR_MESSAGES[authError] ?? "Une erreur est survenue. Réessayez."}
                        </div>
                    )}

                    <button
                        onClick={handleZohoLogin}
                        disabled={loading}
                        className="w-full flex items-center justify-center gap-3 bg-black text-white py-3 rounded-xl text-sm font-semibold hover:bg-slate-800 transition-all disabled:opacity-60"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ZohoIcon />}
                        {loading ? 'Redirection...' : 'Se connecter avec Zoho'}
                    </button>
                </div>

                <p className="text-center text-xs text-slate-300 mt-6">
                    {new Date().getFullYear()} Affichez — Usage interne seulement
                </p>
            </div>
        </div>
    );
}

function ZohoIcon() {
    return (
        <img src="/zoho-logo.svg" alt="Zoho" className="w-28 h-8 object-contain" style={{ mixBlendMode: 'screen' }} />
    );
}
