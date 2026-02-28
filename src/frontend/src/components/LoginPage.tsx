import { useState, type FormEvent } from "react";

interface LoginPageProps {
    onLogin: (password: string) => Promise<void>;
}

export function LoginPage({ onLogin }: LoginPageProps) {
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        if (!password) return;
        setLoading(true);
        setError(null);
        try {
            await onLogin(password);
        } catch (err: unknown) {
            const e = err as { message?: string };
            setError(e.message ?? "Invalid password");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="login-page">
            <div className="login-card">
                <h1>Implementer</h1>
                <p className="subtitle">Admin Dashboard — enter password to continue</p>
                <form onSubmit={(e) => void handleSubmit(e)}>
                    <div className="form-group">
                        <label htmlFor="password">Password</label>
                        <input
                            id="password"
                            type="password"
                            className="form-input"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoFocus
                            disabled={loading}
                            placeholder="Admin password"
                        />
                    </div>
                    {error && <p className="error-msg">{error}</p>}
                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={loading || !password}
                        style={{ marginTop: 16 }}
                    >
                        {loading ? "Signing in…" : "Sign in"}
                    </button>
                </form>
            </div>
        </div>
    );
}
