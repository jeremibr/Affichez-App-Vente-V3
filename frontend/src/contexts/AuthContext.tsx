import { createContext, useContext, useEffect, useState } from 'react';
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

const AuthContext = createContext<AuthContextType>({
    user: null,
    loading: true,
    signOut: async () => {},
    isAdmin: false,
    canAccessFactures: false,
    repName: null,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [isAdmin, setIsAdmin] = useState(false);
    const [canAccessFactures, setCanAccessFactures] = useState(false);
    const [repName, setRepName] = useState<string | null>(null);

    const loadPermissions = async () => {
        const { data } = await supabase.rpc('get_my_permissions');
        if (data) {
            setIsAdmin(data.role === 'admin');
            setCanAccessFactures(data.role === 'admin' || data.can_access_factures === true);
            setRepName(data.rep_name ?? null);
        }
    };

    useEffect(() => {
        supabase.auth.getSession().then(async ({ data: { session } }) => {
            setUser(session?.user ?? null);
            if (session?.user) await loadPermissions();
            setLoading(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
            setUser(session?.user ?? null);
            if (session?.user) await loadPermissions();
            else {
                setIsAdmin(false);
                setCanAccessFactures(false);
                setRepName(null);
            }
        });

        return () => subscription.unsubscribe();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const signOut = async () => { await supabase.auth.signOut(); };

    return (
        <AuthContext.Provider value={{ user, loading, signOut, isAdmin, canAccessFactures, repName }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
