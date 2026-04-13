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

function permissionsFromUser(user: User | null) {
    const meta = user?.user_metadata ?? {};
    const isAdmin = meta.role === 'admin';
    return {
        isAdmin,
        canAccessFactures: isAdmin || meta.can_access_factures === true,
        repName: (meta.rep_name as string | null) ?? null,
    };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setUser(session?.user ?? null);
            setLoading(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setUser(session?.user ?? null);
        });

        return () => subscription.unsubscribe();
    }, []);

    const signOut = async () => { await supabase.auth.signOut(); };
    const { isAdmin, canAccessFactures, repName } = permissionsFromUser(user);

    return (
        <AuthContext.Provider value={{ user, loading, signOut, isAdmin, canAccessFactures, repName }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
