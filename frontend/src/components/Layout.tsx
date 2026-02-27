import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, CalendarDays, LineChart, Settings, Menu } from 'lucide-react';
import { cn } from '../lib/utils';

const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Détail Hebdomadaire', href: '/weekly', icon: CalendarDays },
    { name: 'Moyennes Trimestrielles', href: '/quarterly', icon: LineChart },
    { name: 'Paramètres', href: '/settings', icon: Settings },
];

export default function Layout() {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const location = useLocation();

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
                    <img
                        src="/logo-long.png"
                        alt="Affichez"
                        className="h-7 w-auto object-contain"
                    />
                </div>

                {/* Nav */}
                <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
                    {navigation.map((item) => (
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
                </nav>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-slate-100 shrink-0">
                    <p className="text-xs text-slate-400 font-medium">Tableau de Bord Vente</p>
                    <p className="text-xs text-slate-300 mt-0.5">© {new Date().getFullYear()} Affichez</p>
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

                {/* Mobile topbar */}
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
