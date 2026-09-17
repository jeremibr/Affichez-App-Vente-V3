import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AdminViewProvider } from './contexts/AdminViewContext';
import Layout from './components/Layout';

import Login from './pages/Login';

// Leads module - hidden from the UI while the Comptes module replaces it.
// The pages and every get_zoho_lead* RPC behind them are left intact: the
// account view is the same data at a different grain, and until it is trusted
// this is the only way back to a number someone has already quoted.
// import LeadsDashboard from './pages/LeadsDashboard';
// import LeadsDetail from './pages/LeadsDetail';

/**
 * Every screen is its own chunk.
 *
 * The app used to ship as a single 820 KB bundle, so a rep opening their own
 * portal first downloaded Settings, both payroll screens and every admin page
 * - none of which they can even reach. Now the first paint carries the shell
 * and the one route being visited.
 *
 * Layout imports these same modules for its hover prefetch (see
 * src/lib/prefetch.ts), and Vite gives both importers the same chunk, so
 * hovering a nav link downloads the screen before the click lands.
 */
const Dashboard = lazy(() => import('./pages/Dashboard'));
const WeeklyDetail = lazy(() => import('./pages/WeeklyDetail'));
const QuarterlyAverages = lazy(() => import('./pages/QuarterlyAverages'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const FDashboard = lazy(() => import('./pages/FDashboard'));
const FWeeklyDetail = lazy(() => import('./pages/FWeeklyDetail'));
const FQuarterlyAverages = lazy(() => import('./pages/FQuarterlyAverages'));
const AdminReps = lazy(() => import('./pages/AdminReps'));
const Paye = lazy(() => import('./pages/Paye'));
const PayeRepSettings = lazy(() => import('./pages/PayeRepSettings'));
const PortailDevis = lazy(() => import('./pages/PortailDevis'));
const PortailFactures = lazy(() => import('./pages/PortailFactures'));
const PortailPaye = lazy(() => import('./pages/PortailPaye'));
const PortailObjectifs = lazy(() => import('./pages/PortailObjectifs'));
const PortailParametres = lazy(() => import('./pages/PortailParametres'));
const ObjectifsEquipe = lazy(() => import('./pages/ObjectifsEquipe'));
const AccountsDashboard = lazy(() => import('./pages/AccountsDashboard'));
const AccountsDetail = lazy(() => import('./pages/AccountsDetail'));
const Advertising = lazy(() => import('./pages/Advertising'));
const Createurs = lazy(() => import('./pages/Createurs'));
const PortailLeads = lazy(() => import('./pages/PortailLeads'));
const TasksDashboard = lazy(() => import('./pages/TasksDashboard'));

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
        <Suspense fallback={<RouteFallback />}>
        <Routes>
            <Route path="/" element={<Layout />}>
                {/* ─── Devis module - accessible to all authenticated users ─── */}
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

                {/* ─── Leads module - superseded by Comptes, routes disabled ─── */}
                {/* <Route path="leads" element={<LeadsDashboard />} /> */}
                {/* <Route path="leads/detail" element={<LeadsDetail />} /> */}

                {/* ─── Comptes module - Zoho CRM Accounts, the grain that replaced leads ─── */}
                <Route path="comptes" element={<AccountsDashboard />} />
                <Route path="comptes/detail" element={<AccountsDetail />} />

                {/* ─── Mon Portail - personal view for every rep ─── */}
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

                        {/* "Créé par" - admin-only on purpose. These numbers overlap
                            the rep figures by design and would be misread as a second
                            leaderboard. Dominic, who asked for it: "c'est vraiment
                            juste pour moi, c'est même pas pour personne." */}
                        <Route path="createurs" element={<Createurs />} />

                        {/* Publicité - listed under Comptes in the sidebar, admin-only.
                            ad_spend_daily is also restricted to admins by RLS. */}
                        <Route path="comptes/publicite" element={<Advertising />} />

                        {/* ─── Tâches CRM module (owner-only) - dashboard + weekly tabs ─── */}
                        <Route path="taches" element={<TasksDashboard />} />
                    </>
                )}
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
    );
}

function RouteFallback() {
    return (
        <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin text-primary-press" />
        </div>
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
