import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
    LayoutDashboard, CalendarDays, LineChart, Settings,
    Menu, LogOut, FileText, ClipboardList, Wallet,
    DollarSign, ChevronDown, UserCircle,
    Target, Eye, Building2, BarChart2, Users,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { useRepList } from '../hooks/useRepList';
import { Select } from './Select';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NavItem {
    name: string;
    href: string;
    icon: React.ElementType;
    end?: boolean;
    isLabel?: boolean; // renders as a non-clickable group header
}

interface Section {
    key: string;
    label: string;
    icon: React.ElementType;
    activeColor: string;
    items: NavItem[];
}

// ─── Route → section mapping ──────────────────────────────────────────────────

function getSectionKey(pathname: string): string {
    if (pathname.startsWith('/portail')) return 'portail';
    if (pathname.startsWith('/factures') || pathname === '/' || pathname.startsWith('/weekly') || pathname.startsWith('/quarterly')) return 'ensemble';
    if (pathname.startsWith('/reps') || pathname.startsWith('/paye') || pathname.startsWith('/settings')) return 'admin';
    return 'ensemble';
}

// ─── Module-level components (must NOT be defined inside Layout) ──────────────
// Defining components inside a parent causes React to see a new type on every
// render, which unmounts/remounts the subtree and kills CSS transitions.

function SubItems({ items, open }: { items: NavItem[]; open: boolean }) {
    return (
        <div style={{
            display: 'grid',
            gridTemplateRows: open ? '1fr' : '0fr',
            transition: 'grid-template-rows 300ms ease-in-out',
        }}>
            <div className="overflow-hidden">
                <div className="ml-3 pl-3 border-l-2 border-slate-100 mt-0.5 mb-1 space-y-0.5">
                    {items.map((item, i) =>
                        item.isLabel ? (
                            <p key={`label-${i}`} className="px-3 pt-2.5 pb-1 text-[9px] font-bold text-slate-400 uppercase tracking-widest first:pt-1">
                                {item.name}
                            </p>
                        ) : (
                            <NavLink
                                key={item.href}
                                to={item.href}
                                end={item.end}
                                className={({ isActive }) => cn(
                                    "flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-all",
                                    isActive
                                        ? "bg-brand-main text-white shadow-sm shadow-brand-main/20"
                                        : "text-slate-500 hover:text-slate-800 hover:bg-slate-50"
                                )}
                            >
                                {({ isActive }) => (
                                    <>
                                        <item.icon className={cn(
                                            "w-4 h-4 shrink-0",
                                            isActive ? "text-white/90" : "text-slate-400"
                                        )} />
                                        {item.name}
                                    </>
                                )}
                            </NavLink>
                        )
                    )}
                </div>
            </div>
        </div>
    );
}

function SectionHeader({ label, icon: Icon, activeColor, items, open, active, onToggle }: {
    label: string;
    icon: React.ElementType;
    activeColor: string;
    items: NavItem[];
    open: boolean;
    active: boolean;
    onToggle: () => void;
}) {
    return (
        <div>
            <button
                onClick={onToggle}
                className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all select-none",
                    active ? "text-slate-900" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                )}
            >
                <Icon className={cn("w-4 h-4 shrink-0 transition-colors", active ? activeColor : "text-slate-400")} />
                <span className="flex-1 text-left">{label}</span>
                <ChevronDown className={cn(
                    "w-3.5 h-3.5 shrink-0 text-slate-300 transition-transform duration-300",
                    open && "rotate-180"
                )} />
            </button>
            <SubItems items={items} open={open} />
        </div>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Layout() {
    const location = useLocation();
    const { user, signOut, isAdmin, canAccessFactures } = useAuth();
    const { viewAsRep, setViewAsRep } = useAdminView();
    const repList = useRepList();

    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [openSections, setOpenSections] = useState<Set<string>>(
        () => new Set([getSectionKey(location.pathname)])
    );
    // Auto-open section on navigation
    useEffect(() => {
        const key = getSectionKey(location.pathname);
        setOpenSections(prev => prev.has(key) ? prev : new Set([...prev, key]));
    }, [location.pathname]);

    // Close mobile menu on route change
    useEffect(() => { setIsMobileMenuOpen(false); }, [location.pathname]);

    const displayName = user?.email
        ? user.email.split('@')[0].charAt(0).toUpperCase() + user.email.split('@')[0].slice(1)
        : '';

    // ─── Section definitions ─────────────────────────────────────────────────

    const sections: Section[] = [
        {
            key: 'ensemble',
            label: 'Équipe Affichez',
            icon: Building2,
            activeColor: 'text-blue-500',
            items: [
                { name: 'Devis',           href: '',                    icon: ClipboardList,   isLabel: true },
                { name: 'Tableau de bord', href: '/',                   icon: LayoutDashboard, end: true },
                { name: 'Par semaine',     href: '/weekly',             icon: CalendarDays },
                { name: 'Par trimestre',   href: '/quarterly',          icon: LineChart },
                ...(canAccessFactures ? [
                    { name: 'Factures',        href: '',                    icon: FileText,        isLabel: true },
                    { name: 'Tableau de bord', href: '/factures',           icon: LayoutDashboard, end: true },
                    { name: 'Par semaine',     href: '/factures/weekly',    icon: CalendarDays },
                    { name: 'Par trimestre',   href: '/factures/quarterly', icon: LineChart },
                ] : []),
            ],
        },
        {
            key: 'portail',
            label: 'Mon Portail',
            icon: UserCircle,
            activeColor: 'text-brand-main',
            items: [
                { name: 'Mes Objectifs',   href: '/portail',             icon: Target,             end: true },
                { name: 'Mes Devis',       href: '/portail/devis',       icon: ClipboardList },
                { name: 'Mes Factures',    href: '/portail/factures',    icon: FileText },
                { name: 'Ma Paye',         href: '/portail/paye',        icon: Wallet },
            ],
        },
    ];

    const adminItems: NavItem[] = [
        { name: 'Commissions',     href: '',                    icon: DollarSign,   isLabel: true },
        { name: 'Vue ensemble',    href: '/paye',               icon: BarChart2,  end: true },
        { name: 'Paramètres reps', href: '/paye/settings',      icon: Users },
        { name: 'Objectifs',        href: '',                     icon: Target,       isLabel: true },
        { name: 'Objectifs Équipe', href: '/objectifs/equipe',   icon: Target,       end: true },
        { name: 'Objectifs Reps',   href: '/portail/parametres', icon: Target },
        { name: 'Système',         href: '',                    icon: Settings,     isLabel: true },
        { name: 'Paramètres',      href: '/settings',           icon: Settings },
    ];

    // ─── Helpers ──────────────────────────────────────────────────────────────

    const toggle = (key: string) =>
        setOpenSections(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });

    const isSectionActive = (items: NavItem[]) =>
        items.some(item =>
            !item.isLabel && item.href &&
            (item.end ? location.pathname === item.href : location.pathname.startsWith(item.href))
        );


    // ─── Sidebar content ──────────────────────────────────────────────────────

    const sidebar = (
        <div className="flex flex-col h-full bg-white">

            {/* Logo */}
            <div className="h-16 px-6 flex items-center shrink-0 border-b border-slate-100">
                <img src="/logo-long.png" alt="Affichez" className="h-7 w-auto object-contain" />
            </div>

            {/* Main nav */}
            <nav className="flex-1 px-3 py-3 overflow-y-auto space-y-0.5">
                {sections.map(s => (
                    <SectionHeader
                        key={s.key}
                        label={s.label}
                        icon={s.icon}
                        activeColor={s.activeColor}
                        items={s.items}
                        open={openSections.has(s.key)}
                        active={isSectionActive(s.items)}
                        onToggle={() => toggle(s.key)}
                    />
                ))}
            </nav>

            {/* Bottom: Admin + rep switcher + user */}
            <div className="shrink-0 border-t border-slate-100 px-3 py-3 space-y-0.5">

                {/* Admin section — hidden when viewing as rep */}
                {isAdmin && !viewAsRep && (
                    <SectionHeader
                        label="Administration"
                        icon={Settings}
                        activeColor="text-slate-500"
                        items={adminItems}
                        open={openSections.has('admin')}
                        active={isSectionActive(adminItems)}
                        onToggle={() => toggle('admin')}
                    />
                )}

                {/* User row */}
                <div className="flex items-center gap-3 px-3 py-2 mt-1 rounded-xl hover:bg-slate-50 transition-colors">
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
        </div>
    );

    // ─── Layout ───────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-slate-50 flex font-sans">

            {/* Sidebar */}
            <aside className={cn(
                "fixed md:sticky top-0 left-0 z-50 h-screen w-60 border-r border-slate-100 shrink-0 transition-transform duration-300",
                isMobileMenuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
            )}>
                {sidebar}
            </aside>

            {/* Mobile backdrop */}
            {isMobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-black/30 z-40 md:hidden backdrop-blur-sm"
                    onClick={() => setIsMobileMenuOpen(false)}
                />
            )}

            {/* Main content */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

                {/* Mobile header */}
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

                {/* Admin view-as bar */}
                {isAdmin && repList.length > 0 && (
                    <div className="shrink-0 bg-white border-b border-slate-100 px-3 md:px-4 py-2 flex items-center gap-2 md:gap-3">
                        <Eye className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="text-xs font-semibold text-slate-500 shrink-0">Vue :</span>
                        <Select
                            value={viewAsRep ?? ''}
                            onChange={v => setViewAsRep(v || null)}
                            options={[
                                { value: '', label: 'Admin (ma vue)' },
                                ...repList.map(r => ({ value: r, label: r })),
                            ]}
                            variant={viewAsRep ? 'accent' : 'default'}
                            className="w-40 md:w-48 min-w-0"
                        />
                    </div>
                )}

                <main className="flex-1 overflow-auto">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
