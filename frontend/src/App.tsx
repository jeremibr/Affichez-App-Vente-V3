import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import WeeklyDetail from './pages/WeeklyDetail';
import QuarterlyAverages from './pages/QuarterlyAverages';
import SettingsPage from './pages/Settings';
import Login from './pages/Login';
import FDashboard from './pages/FDashboard';
import FWeeklyDetail from './pages/FWeeklyDetail';
import FQuarterlyAverages from './pages/FQuarterlyAverages';

function AppRoutes() {
    const { user, loading, canAccessFactures } = useAuth();

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
                {/* ─── Devis module ─── */}
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
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}

export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AppRoutes />
            </AuthProvider>
        </BrowserRouter>
    );
}
