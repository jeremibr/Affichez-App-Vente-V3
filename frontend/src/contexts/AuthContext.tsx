import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthContextType {
    user: User | null;
    loading: boolean;
    signOut: () => Promise<void>;
    isAdmin: boolean;
    canAccessFactures: boolean;
    repName: string | null;
}

interface Permissions {
    isAdmin: boolean;
    canAccessFactures: boolean;
    repName: string | null;
}

const DEFAULT_PERMS: Permissions = { isAdmin: false, canAccessFactures: false, repName: null };

const AuthContext = createContext<AuthContextType>({
    user: null,
    loading: true,
    signOut: async () => {},
    ...DEFAULT_PERMS,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser]           = useState<User | null>(null);
    const [loading, setLoading]     = useState(true);
    const [perms, setPerms]         = useState<Permissions>(DEFAULT_PERMS);

    const resolvePerms = useCallback(async (u: User | null) => {
        if (!u?.email) { setPerms(DEFAULT_PERMS); return; }

        // Always read live from allowed_users so role/permission changes take effect
        // on the user's next page load — no need to log out + back in.
        const { data } = await supabase
            .from('allowed_users')
            .select('role, can_access_factures, rep_name')
            .eq('email', u.email)
            .maybeSingle();

        if (data) {
            const isAdmin = data.role === 'admin';
            setPerms({
                isAdmin,
                canAccessFactures: isAdmin || data.can_access_factures === true,
                repName: (data.rep_name as string | null) ?? null,
            });
        } else {
            setPerms(DEFAULT_PERMS);
        }
    }, []);

    useEffect(() => {
        supabase.auth.getSession().then(async ({ data: { session } }) => {
            const u = session?.user ?? null;
            setUser(u);
            await resolvePerms(u);
            setLoading(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            const u = session?.user ?? null;
            setUser(u);
            resolvePerms(u);
        });

        return () => subscription.unsubscribe();
    }, [resolvePerms]);

    // Live-refresh perms when this user's allowed_users row changes.
    // Also refresh the JWT so admin RLS policies (which read user_metadata
    // from the JWT) pick up the new role without requiring a re-login.
    useEffect(() => {
        if (!user?.email) return;
        const channel = supabase.channel(`perms-${user.email}`)
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'allowed_users', filter: `email=eq.${user.email}` },
                async () => {
                    await supabase.auth.refreshSession();
                    resolvePerms(user);
                }
            ).subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [user, resolvePerms]);

    const signOut = async () => { await supabase.auth.signOut(); };

    return (
        <AuthContext.Provider value={{ user, loading, signOut, ...perms }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
