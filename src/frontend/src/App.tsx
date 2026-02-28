import { useDashboard } from "./hooks/useDashboard";
import { LoginPage } from "./components/LoginPage";
import { DashboardPage } from "./components/DashboardPage";

export function App() {
    const { authState, data, login, logout, refresh } = useDashboard();

    if (authState === "loading") {
        return (
            <div className="loading-screen">
                <div className="spinner" />
                Loading…
            </div>
        );
    }

    if (authState === "unauthenticated") {
        return <LoginPage onLogin={login} />;
    }

    if (!data) {
        return (
            <div className="loading-screen">
                <div className="spinner" />
                Loading dashboard data…
            </div>
        );
    }

    return <DashboardPage data={data} onRefresh={refresh} onLogout={logout} />;
}
