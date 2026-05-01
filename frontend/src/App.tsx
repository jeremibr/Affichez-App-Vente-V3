import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AdminViewProvider } from './contexts/AdminViewContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import WeeklyDetail from './pages/WeeklyDetail';
import QuarterlyAverages from './pages/QuarterlyAverages';
import SettingsPage from './pages/Settings';
import Login from './pages/Login';
import FDashboard from './pages/FDashboard';
import FWeeklyDetail from './pages/FWeeklyDetail';
import FQuarterlyAverages from './pages/FQuarterlyAverages';
import AdminReps from './pages/AdminReps';
import Paye from './pages/Paye';
import PortailDevis from './pages/PortailDevis';
import PortailFactures from './pages/PortailFactures';
import PortailPaye from './pages/PortailPaye';
import PortailObjectifs from './pages/PortailObjectifs';
import PortailParametres from './pages/PortailParametres';

function AppRoutes() {
    const { user, loading, canAccessFactures, isAdmin } = useAuth();

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-brand-main" />
            </div>
        );
    }

    if (!user) {
        return <Login />;
    }

    return (
        <Routes>
            <Route path="/" element={<Layout />}>
                {/* ─── Devis module — accessible to all authenticated users ─── */}
                <Route index element={<Dashboard />} />
                <Route path="weekly" element={<WeeklyDetail />} />
                <Route path="quarterly" element={<QuarterlyAverages />} />
                <Route path="settings" element={<SettingsPage />} />

                {/* ─── Factures module (requires canAccessFactures) ─── */}
                {canAccessFactures && (
                    <>
                        <Route path="factures" element={<FDashboard />} />
                        <Route path="factures/weekly" element={<FWeeklyDetail />} />
                        <Route path="factures/quarterly" element={<FQuarterlyAverages />} />
                    </>
                )}

                {/* ─── Mon Portail — personal view for every rep ─── */}
                <Route path="portail" element={<PortailObjectifs />} />
                <Route path="portail/devis" element={<PortailDevis />} />
                <Route path="portail/factures" element={<PortailFactures />} />
                <Route path="portail/paye" element={<PortailPaye />} />
                <Route path="portail/parametres" element={<PortailParametres />} />

                {/* ─── Admin-only ─── */}
                {isAdmin && (
                    <>
                        <Route path="reps" element={<AdminReps />} />
                        <Route path="paye" element={<Paye />} />
                    </>
                )}
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}

export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AdminViewProvider>
                    <AppRoutes />
                </AdminViewProvider>
            </AuthProvider>
        </BrowserRouter>
    );
}
