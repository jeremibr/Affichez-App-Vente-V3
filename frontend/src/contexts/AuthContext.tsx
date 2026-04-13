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

interface UserPermissions {
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

async function fetchPermissions(email: string): Promise<UserPermissions> {
    const { data } = await supabase
        .from('allowed_users')
        .select('role, can_access_factures, rep_name')
        .eq('email', email.toLowerCase())
        .maybeSingle();

    if (!data) {
        // Domain fallback: @affichez.ca gets basic member access
        return { isAdmin: false, canAccessFactures: false, repName: null };
    }
    const isAdmin = data.role === 'admin';
    return {
        isAdmin,
        canAccessFactures: isAdmin || data.can_access_factures === true,
        repName: data.rep_name ?? null,
    };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [permissions, setPermissions] = useState<UserPermissions>({
        isAdmin: false,
        canAccessFactures: false,
        repName: null,
    });

    useEffect(() => {
        supabase.auth.getSession().then(async ({ data: { session } }) => {
            const u = session?.user ?? null;
            setUser(u);
            if (u?.email) setPermissions(await fetchPermissions(u.email));
            setLoading(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
            const u = session?.user ?? null;
            setUser(u);
            if (u?.email) setPermissions(await fetchPermissions(u.email));
            else setPermissions({ isAdmin: false, canAccessFactures: false, repName: null });
        });

        return () => subscription.unsubscribe();
    }, []);

    const signOut = async () => {
        await supabase.auth.signOut();
    };

    return (
        <AuthContext.Provider value={{ user, loading, signOut, ...permissions }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
