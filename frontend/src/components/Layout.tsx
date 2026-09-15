import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
    LayoutDashboard, CalendarDays, LineChart, Settings,
    Menu, LogOut, FileText, ClipboardList, Wallet,
    DollarSign, ChevronDown, UserCircle,
    Target, Eye, Building2, BarChart2, Users, UserPlus, List,
    CheckSquare, FileSignature,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { useRepList } from '../hooks/useRepList';
import { Select } from './Select';
import { Logo } from './Logo';
import { prefetchRoute } from '../lib/prefetch';
import { RepAvatar } from './RepAvatar';

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
    if (pathname.startsWith('/leads') || pathname.startsWith('/comptes')) return 'ensemble';
    if (pathname.startsWith('/factures') || pathname === '/' || pathname.startsWith('/weekly') || pathname.startsWith('/quarterly')) return 'ensemble';
    if (pathname.startsWith('/reps') || pathname.startsWith('/paye') || pathname.startsWith('/settings') || pathname.startsWith('/taches') || pathname.startsWith('/createurs')) return 'admin';
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
                <div className="ml-3 pl-3 border-l-2 border-hairline mt-0.5 mb-1 space-y-0.5">
                    {items.map((item, i) =>
                        item.isLabel ? (
                            <p key={`label-${i}`} className="px-3 pt-2.5 pb-1 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow first:pt-1">
                                {item.name}
                            </p>
                        ) : (
                            <NavLink
                                key={item.href}
                                to={item.href}
                                end={item.end}
                                // The screen's chunk and its first query start
                                // loading while the pointer is still travelling.
                                onMouseEnter={() => prefetchRoute(item.href)}
                                onFocus={() => prefetchRoute(item.href)}
                                onTouchStart={() => prefetchRoute(item.href)}
                                className={({ isActive }) => cn(
                                    "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-all",
                                    isActive
                                        ? "bg-primary text-white shadow-xs"
                                        : "text-ink-mute hover:text-ink hover:bg-sand"
                                )}
                            >
                                {({ isActive }) => (
                                    <>
                                        <item.icon className={cn(
                                            "w-4 h-4 shrink-0",
                                            isActive ? "text-white" : "text-ink-mute"
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
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-semibold transition-all select-none",
                    active ? "text-ink" : "text-ink-mute hover:text-ink-secondary hover:bg-sand"
                )}
            >
                <Icon className={cn("w-4 h-4 shrink-0 transition-colors", active ? activeColor : "text-ink-mute")} />
                <span className="flex-1 text-left">{label}</span>
                <ChevronDown className={cn(
                    "w-3.5 h-3.5 shrink-0 text-ink-faint transition-transform duration-300",
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
    const { user, signOut, isAdmin, canAccessFactures, repName } = useAuth();
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
            activeColor: 'text-ink',
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
                // Leads - hidden while the Comptes module replaces it. Routes are
                // commented out in App.tsx; leaving these visible would 404.
                // { name: 'Leads',           href: '',                    icon: UserPlus,        isLabel: true },
                // { name: 'Tableau de bord', href: '/leads',              icon: LayoutDashboard, end: true },
                // { name: 'Détail leads',    href: '/leads/detail',       icon: List },
                { name: 'Comptes',         href: '',                    icon: Building2,       isLabel: true },
                { name: 'Tableau de bord', href: '/comptes',            icon: LayoutDashboard, end: true },
                { name: 'Détail comptes',  href: '/comptes/detail',     icon: List },
            ],
        },
        {
            key: 'portail',
            label: 'Mon Portail',
            icon: UserCircle,
            activeColor: 'text-ink',
            items: [
                { name: 'Mes Objectifs',   href: '/portail',             icon: Target,             end: true },
                { name: 'Mes Devis',       href: '/portail/devis',       icon: ClipboardList },
                { name: 'Mes Factures',    href: '/portail/factures',    icon: FileText },
                { name: 'Ma Paye',         href: '/portail/paye',        icon: Wallet },
                { name: 'Mes Leads',       href: '/portail/leads',       icon: UserPlus },
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
        { name: 'Créé par',         href: '',                    icon: FileSignature, isLabel: true },
        { name: 'Devis et factures', href: '/createurs',         icon: FileSignature, end: true },
        { name: 'Tâches CRM',       href: '',                    icon: CheckSquare,  isLabel: true },
        { name: 'Tableau de bord', href: '/taches',             icon: LayoutDashboard, end: true },
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
            <div className="h-16 px-6 flex items-center shrink-0 border-b border-hairline">
                <Logo height={24} />
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
            <div className="shrink-0 border-t border-hairline px-3 py-3 space-y-0.5">

                {/* Admin section - hidden when viewing as rep */}
                {isAdmin && !viewAsRep && (
                    <SectionHeader
                        label="Administration"
                        icon={Settings}
                        activeColor="text-ink"
                        items={adminItems}
                        open={openSections.has('admin')}
                        active={isSectionActive(adminItems)}
                        onToggle={() => toggle('admin')}
                    />
                )}

                {/* User row */}
                <div className="flex items-center gap-3 px-3 py-2 mt-1 rounded-md hover:bg-sand transition-colors">
                    {/* The signed-in person's own face. repName comes from
                      * allowed_users, so an admin with no rep row falls through
                      * to the initial of their email handle, as before. */}
                    {repName
                        ? <RepAvatar name={repName} size="md" />
                        : <div className="w-8 h-8 rounded-full bg-primary-wash text-primary-press flex items-center justify-center text-xs font-bold shrink-0">
                              {displayName.charAt(0)}
                          </div>}
                    <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-ink-secondary truncate">{displayName}</p>
                        <p className="text-2xs text-ink-mute truncate">{user?.email}</p>
                    </div>
                    <button
                        onClick={signOut}
                        title="Se déconnecter"
                        className="p-1.5 rounded-md text-ink-faint hover:text-ink-secondary hover:bg-stone transition-all shrink-0"
                    >
                        <LogOut className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </div>
    );

    // ─── Layout ───────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-sand flex font-sans">

            {/* Sidebar */}
            <aside className={cn(
                "fixed md:sticky top-0 left-0 z-50 h-screen w-60 border-r border-hairline shrink-0 transition-transform duration-300",
                isMobileMenuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
            )}>
                {sidebar}
            </aside>

            {/* Mobile backdrop */}
            {isMobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-black/30 z-40 md:hidden backdrop-blur-xs"
                    onClick={() => setIsMobileMenuOpen(false)}
                />
            )}

            {/* Main content */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

                {/* Mobile header */}
                <header className="md:hidden h-14 bg-white border-b border-hairline flex items-center justify-between px-4 sticky top-0 z-30">
                    <button
                        onClick={() => setIsMobileMenuOpen(true)}
                        className="p-2 text-ink-mute hover:bg-sand rounded-md"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <Logo height={22} />
                    <div className="w-9" />
                </header>

                {/* Admin view-as bar */}
                {isAdmin && repList.length > 0 && (
                    <div className="shrink-0 bg-white border-b border-hairline px-3 md:px-4 py-2 flex items-center gap-2 md:gap-3">
                        <Eye className="w-3.5 h-3.5 text-ink-mute shrink-0" />
                        <span className="text-xs font-semibold text-ink-mute shrink-0">Vue :</span>
                        <Select
                            value={viewAsRep ?? ''}
                            onChange={v => setViewAsRep(v || null)}
                            options={[
                                { value: '', label: 'Admin (ma vue)' },
                                ...repList.map(r => ({ value: r, label: r, icon: <RepAvatar name={r} size="sm" /> })),
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
