import { useState, useCallback, useEffect } from "react";

export type Theme = "dark" | "light";

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
    const [theme, setTheme] = useState<Theme>(() => {
        try {
            return localStorage.getItem("impl-theme") === "light" ? "light" : "dark";
        } catch {
            return "dark";
        }
    });

    useEffect(() => {
        if (theme === "light") {
            document.documentElement.setAttribute("data-theme", "light");
        } else {
            document.documentElement.removeAttribute("data-theme");
        }
    }, [theme]);

    const toggleTheme = useCallback(() => {
        setTheme((prev) => {
            const next = prev === "dark" ? "light" : "dark";
            try {
                if (next === "light") {
                    localStorage.setItem("impl-theme", "light");
                } else {
                    localStorage.removeItem("impl-theme");
                }
            } catch {
                // ignore
            }
            return next;
        });
    }, []);

    return { theme, toggleTheme };
}
