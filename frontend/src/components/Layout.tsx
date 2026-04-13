import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, CalendarDays, LineChart, Settings, Menu, LogOut, FileText, ClipboardList, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';

const modules = {
    devis: {
        label: 'Devis',
        icon: ClipboardList,
        root: '/',
        nav: [
            { name: 'Dashboard',              href: '/',          icon: LayoutDashboard },
            { name: 'Détail Hebdomadaire',    href: '/weekly',    icon: CalendarDays },
            { name: 'Moyennes Trimestrielles',href: '/quarterly', icon: LineChart },
        ],
    },
    factures: {
        label: 'Factures',
        icon: FileText,
        root: '/factures',
        nav: [
            { name: 'Dashboard',              href: '/factures',          icon: LayoutDashboard },
            { name: 'Détail Hebdomadaire',    href: '/factures/weekly',   icon: CalendarDays },
            { name: 'Moyennes Trimestrielles',href: '/factures/quarterly',icon: LineChart },
        ],
    },
} as const;

type ModuleKey = keyof typeof modules;

export default function Layout() {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [modulePickerOpen, setModulePickerOpen] = useState(false);
    const location = useLocation();
    const navigate = useNavigate();
    const { user, signOut, isAdmin, canAccessFactures } = useAuth();

    // Derive active module from current route
    const activeModule: ModuleKey = location.pathname.startsWith('/factures') ? 'factures' : 'devis';
    const mod = modules[activeModule];

    const displayName = user?.email
        ? user.email.split('@')[0].charAt(0).toUpperCase() + user.email.split('@')[0].slice(1)
        : '';

    useEffect(() => { setIsMobileMenuOpen(false); }, [location]);
    useEffect(() => {
        if (!modulePickerOpen) return;
        const close = () => setModulePickerOpen(false);
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [modulePickerOpen]);

    const switchModule = (key: ModuleKey) => {
        setModulePickerOpen(false);
        navigate(modules[key].root);
    };

    const ModuleIcon = mod.icon;

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

                {/* Module switcher */}
                {canAccessFactures && (
                    <div className="px-3 pt-4 pb-1">
                        <div className="relative">
                            <button
                                onClick={(e) => { e.stopPropagation(); setModulePickerOpen(v => !v); }}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200/60 transition-all group"
                            >
                                <div className="w-7 h-7 rounded-lg bg-brand-main/10 flex items-center justify-center shrink-0">
                                    <ModuleIcon className="w-3.5 h-3.5 text-brand-main" />
                                </div>
                                <span className="flex-1 text-left text-sm font-semibold text-slate-700">{mod.label}</span>
                                <ChevronDown className={cn("w-4 h-4 text-slate-400 transition-transform duration-200", modulePickerOpen && "rotate-180")} />
                            </button>

                            {modulePickerOpen && (
                                <div className="absolute top-full left-0 right-0 mt-1.5 bg-white rounded-xl border border-slate-200 shadow-lg shadow-slate-200/60 overflow-hidden z-10">
                                    {(Object.entries(modules) as [ModuleKey, typeof modules[ModuleKey]][]).map(([key, m]) => {
                                        const Icon = m.icon;
                                        return (
                                            <button
                                                key={key}
                                                onClick={(e) => { e.stopPropagation(); switchModule(key); }}
                                                className={cn(
                                                    "w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors",
                                                    key === activeModule
                                                        ? "bg-brand-main/5 text-brand-main"
                                                        : "text-slate-600 hover:bg-slate-50"
                                                )}
                                            >
                                                <div className={cn(
                                                    "w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
                                                    key === activeModule ? "bg-brand-main/10" : "bg-slate-100"
                                                )}>
                                                    <Icon className="w-3.5 h-3.5" />
                                                </div>
                                                {m.label}
                                                {key === activeModule && (
                                                    <span className="ml-auto w-1.5 h-1.5 rounded-full bg-brand-main" />
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Nav links */}
                <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
                    {mod.nav.map((item) => (
                        <NavLink
                            key={item.href}
                            to={item.href}
                            end={item.href === '/' || item.href === '/factures'}
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

                {/* Bottom: Settings + user */}
                <div className="px-3 pb-4 shrink-0 space-y-1 border-t border-slate-100 pt-3">
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

                    <div className="flex items-center gap-3 px-3 py-2 mt-1">
                        <div className="w-7 h-7 rounded-full bg-brand-main/10 text-brand-main flex items-center justify-center text-xs font-bold shrink-0">
                            {displayName.charAt(0)}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-slate-700 truncate">{displayName}</p>
                            <p className="text-[10px] text-slate-400 truncate">{user?.email}</p>
                        </div>
                        <button
                            onClick={signOut}
                            title="Se déconnecter"
                            className="p-1.5 rounded-lg text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-all shrink-0"
                        >
                            <LogOut className="w-3.5 h-3.5" />
                        </button>
                    </div>
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
