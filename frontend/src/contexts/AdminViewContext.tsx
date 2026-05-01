import { createContext, useContext, useState } from 'react';

interface AdminViewContextType {
    viewAsRep: string | null;
    setViewAsRep: (rep: string | null) => void;
}

const AdminViewContext = createContext<AdminViewContextType>({
    viewAsRep: null,
    setViewAsRep: () => {},
});

export function AdminViewProvider({ children }: { children: React.ReactNode }) {
    const [viewAsRep, setViewAsRep] = useState<string | null>(null);
    return (
        <AdminViewContext.Provider value={{ viewAsRep, setViewAsRep }}>
            {children}
        </AdminViewContext.Provider>
    );
}

export const useAdminView = () => useContext(AdminViewContext);
