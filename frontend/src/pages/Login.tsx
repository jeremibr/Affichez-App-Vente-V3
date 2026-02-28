import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Loader2 } from 'lucide-react';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            setError('Courriel ou mot de passe invalide.');
            setLoading(false);
        }
        // On success, AuthContext picks up the session and App re-renders automatically
    };

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm">

                {/* Logo */}
                <div className="flex justify-center mb-8">
                    <img
                        src="/logo-long.png"
                        alt="Affichez"
                        className="h-9 w-auto object-contain"
                    />
                </div>

                {/* Card */}
                <div className="bg-white rounded-2xl border border-slate-100 shadow-lg shadow-slate-200/60 p-8">
                    <div className="mb-6">
                        <h1 className="text-xl font-bold text-slate-900">Bon retour</h1>
                        <p className="text-sm text-slate-400 mt-1">Connectez-vous à votre tableau de bord.</p>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                                Courriel
                            </label>
                            <input
                                type="email"
                                autoComplete="email"
                                required
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="vous@affichez.ca"
                                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-main/30 focus:border-brand-main/50 transition-all"
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                                Mot de passe
                            </label>
                            <input
                                type="password"
                                autoComplete="current-password"
                                required
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="••••••••••••"
                                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-main/30 focus:border-brand-main/50 transition-all"
                            />
                        </div>

                        {error && (
                            <p className="text-xs font-medium text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                                {error}
                            </p>
                        )}

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full flex items-center justify-center gap-2 bg-brand-main text-white py-2.5 rounded-xl text-sm font-semibold shadow-sm shadow-brand-main/30 hover:bg-brand-main/90 transition-all disabled:opacity-60 mt-2"
                        >
                            {loading
                                ? <><Loader2 className="w-4 h-4 animate-spin" /> Connexion...</>
                                : 'Se connecter'
                            }
                        </button>
                    </form>
                </div>

                <p className="text-center text-xs text-slate-300 mt-6">
                    © {new Date().getFullYear()} Affichez — Usage interne seulement
                </p>
            </div>
        </div>
    );
}
