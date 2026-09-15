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
import PayeRepSettings from './pages/PayeRepSettings';
import PortailDevis from './pages/PortailDevis';
import PortailFactures from './pages/PortailFactures';
import PortailPaye from './pages/PortailPaye';
import PortailObjectifs from './pages/PortailObjectifs';
import PortailParametres from './pages/PortailParametres';
import ObjectifsEquipe from './pages/ObjectifsEquipe';
// Leads module — hidden from the UI while the Comptes module replaces it.
// The pages and every get_zoho_lead* RPC behind them are left intact: the
// account view is the same data at a different grain, and until it is trusted
// this is the only way back to a number someone has already quoted.
// import LeadsDashboard from './pages/LeadsDashboard';
// import LeadsDetail from './pages/LeadsDetail';
import AccountsDashboard from './pages/AccountsDashboard';
import AccountsDetail from './pages/AccountsDetail';
import Createurs from './pages/Createurs';
import PortailLeads from './pages/PortailLeads';
import TasksDashboard from './pages/TasksDashboard';

function AppRoutes() {
    const { user, loading, canAccessFactures, isAdmin } = useAuth();

    if (loading) {
        return (
            <div className="min-h-screen bg-sand flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
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

                {/* ─── Leads module — superseded by Comptes, routes disabled ─── */}
                {/* <Route path="leads" element={<LeadsDashboard />} /> */}
                {/* <Route path="leads/detail" element={<LeadsDetail />} /> */}

                {/* ─── Comptes module — Zoho CRM Accounts, the grain that replaced leads ─── */}
                <Route path="comptes" element={<AccountsDashboard />} />
                <Route path="comptes/detail" element={<AccountsDetail />} />

                {/* ─── Mon Portail — personal view for every rep ─── */}
                <Route path="portail" element={<PortailObjectifs />} />
                <Route path="portail/devis" element={<PortailDevis />} />
                <Route path="portail/factures" element={<PortailFactures />} />
                <Route path="portail/paye" element={<PortailPaye />} />
                <Route path="portail/leads" element={<PortailLeads />} />
                <Route path="portail/parametres" element={<PortailParametres />} />

                {/* ─── Admin-only ─── */}
                {isAdmin && (
                    <>
                        <Route path="reps" element={<AdminReps />} />
                        <Route path="paye" element={<Paye />} />
                        <Route path="paye/settings" element={<PayeRepSettings />} />
                        <Route path="objectifs/equipe" element={<ObjectifsEquipe />} />

                        {/* "Créé par" — admin-only on purpose. These numbers overlap
                            the rep figures by design and would be misread as a second
                            leaderboard. Dominic, who asked for it: "c'est vraiment
                            juste pour moi, c'est même pas pour personne." */}
                        <Route path="createurs" element={<Createurs />} />

                        {/* ─── Tâches CRM module (owner-only) — dashboard + weekly tabs ─── */}
                        <Route path="taches" element={<TasksDashboard />} />
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
