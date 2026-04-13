import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, CalendarDays, LineChart, Settings, Menu, LogOut, FileText } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';

const devisNav = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Détail Hebdomadaire', href: '/weekly', icon: CalendarDays },
    { name: 'Moyennes Trimestrielles', href: '/quarterly', icon: LineChart },
];

const facturesNav = [
    { name: 'Dashboard', href: '/factures', icon: LayoutDashboard },
    { name: 'Détail Hebdomadaire', href: '/factures/weekly', icon: CalendarDays },
    { name: 'Moyennes Trimestrielles', href: '/factures/quarterly', icon: LineChart },
];

export default function Layout() {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const location = useLocation();
    const { user, signOut, isAdmin, canAccessFactures } = useAuth();

    const displayName = user?.email
        ? user.email.split('@')[0].charAt(0).toUpperCase() + user.email.split('@')[0].slice(1)
        : '';

    useEffect(() => {
        setIsMobileMenuOpen(false);
    }, [location]);

    return (
        <div className="min-h-screen bg-slate-50 flex font-sans">

            {/* ─── Sidebar ─── */}
            <aside className={cn(
                "fixed md:sticky top-0 left-0 z-50 h-screen w-64 bg-white border-r border-slate-100 flex flex-col shrink-0 transition-transform duration-300",
                isMobileMenuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
            )}>
                {/* Logo */}
                <div className="h-16 px-6 flex items-center shrink-0 border-b border-slate-100">
                    <img src="/logo-long.png" alt="Affichez" className="h-7 w-auto object-contain" />
                </div>

                {/* Nav */}
                <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-4">

                    {/* ─── Devis section ─── */}
                    <div>
                        <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                            Devis
                        </p>
                        <div className="space-y-0.5">
                            {devisNav.map((item) => (
                                <NavLink
                                    key={item.href}
                                    to={item.href}
                                    end={item.href === '/'}
                                    className={({ isActive }) => cn(
                                        "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
                                        isActive
                                            ? "bg-brand-main text-white shadow-sm shadow-brand-main/20"
                                            : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                                    )}
                                >
                                    <item.icon className="w-4 h-4 shrink-0" />
                                    {item.name}
                                </NavLink>
                            ))}
                            {isAdmin && (
                                <NavLink
                                    to="/settings"
                                    className={({ isActive }) => cn(
                                        "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
                                        isActive
                                            ? "bg-brand-main text-white shadow-sm shadow-brand-main/20"
                                            : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                                    )}
                                >
                                    <Settings className="w-4 h-4 shrink-0" />
                                    Paramètres
                                </NavLink>
                            )}
                        </div>
                    </div>

                    {/* ─── Factures section (conditional) ─── */}
                    {canAccessFactures && (
                        <div>
                            <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                <FileText className="w-3 h-3" />
                                Factures
                            </p>
                            <div className="space-y-0.5">
                                {facturesNav.map((item) => (
                                    <NavLink
                                        key={item.href}
                                        to={item.href}
                                        end={item.href === '/factures'}
                                        className={({ isActive }) => cn(
                                            "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
                                            isActive
                                                ? "bg-brand-main text-white shadow-sm shadow-brand-main/20"
                                                : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                                        )}
                                    >
                                        <item.icon className="w-4 h-4 shrink-0" />
                                        {item.name}
                                    </NavLink>
                                ))}
                            </div>
                        </div>
                    )}
                </nav>

                {/* Footer */}
                <div className="px-4 py-4 border-t border-slate-100 shrink-0 space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-brand-main/10 text-brand-main flex items-center justify-center text-xs font-bold shrink-0">
                            {displayName.charAt(0)}
                        </div>
                        <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-700 truncate">{displayName}</p>
                            <p className="text-[10px] text-slate-400 truncate">{user?.email}</p>
                        </div>
                    </div>
                    <button
                        onClick={signOut}
                        className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-all"
                    >
                        <LogOut className="w-3.5 h-3.5" />
                        Se déconnecter
                    </button>
                </div>
            </aside>

            {/* Mobile overlay */}
            {isMobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-black/30 z-40 md:hidden backdrop-blur-sm"
                    onClick={() => setIsMobileMenuOpen(false)}
                />
            )}

            {/* ─── Main ─── */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <header className="md:hidden h-14 bg-white border-b border-slate-100 flex items-center justify-between px-4 sticky top-0 z-30">
                    <button
                        onClick={() => setIsMobileMenuOpen(true)}
                        className="p-2 text-slate-500 hover:bg-slate-50 rounded-lg"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <img src="/logo-long.png" alt="Affichez" className="h-6 w-auto object-contain" />
                    <div className="w-9" />
                </header>
                <main className="flex-1 overflow-auto">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
