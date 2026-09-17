import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';

/** Raised when a lazy route chunk from an older build can no longer be fetched. */
const STALE_CHUNK = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

interface State {
    error: Error | null;
}

/**
 * Catches render errors (and failed lazy-route loads) inside the routed screen,
 * so a crash shows a message with the cause instead of a blank page. Keyed by
 * pathname in Layout, so navigating to another screen clears it.
 */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('Screen crashed:', error, info.componentStack);
    }

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        const stale = STALE_CHUNK.test(error.message);
        return (
            <div className="p-4 md:p-8 max-w-2xl mx-auto">
                <div className="bg-white rounded-xl shadow-card p-6 space-y-3">
                    <h1 className="text-base font-semibold text-ink flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-tone-critical shrink-0" />
                        {stale
                            ? 'Une nouvelle version de l’application est disponible'
                            : 'Cette page a rencontré une erreur'}
                    </h1>
                    <p className="text-sm text-ink-mute">
                        {stale
                            ? 'Rechargez la page pour charger la nouvelle version.'
                            : 'Rechargez la page. Si le problème revient, transmettez le message ci-dessous.'}
                    </p>
                    {!stale && (
                        <pre className="text-2xs bg-sand rounded-md p-3 overflow-x-auto whitespace-pre-wrap text-ink-secondary">
                            {error.message}
                        </pre>
                    )}
                    <button type="button" onClick={() => window.location.reload()} className="btn btn-md btn-primary">
                        <RefreshCcw className="w-4 h-4" /> Recharger la page
                    </button>
                </div>
            </div>
        );
    }
}
