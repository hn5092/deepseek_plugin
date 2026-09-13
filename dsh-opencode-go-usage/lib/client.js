window.__ModuleLoader__.load({
    id: "dsh-opencode-go-usage",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        const react = require("react");
        const h = react.createElement;

        /** Exact route registered by the host half; keep in sync with lib/index.js `path`. */
        const ROUTE = "/opencode-go-usage";
        /** The host caches for 30s, so polling faster would only re-read its cache. */
        const POLL_MS = 30000;
/**
         * Click padding around the chip rect, in px. The DSH conversation header has a
         * cover over the actions slot that swallows direct clicks, so the toggle below is
         * confirmed geometrically on the capture phase instead of trusting the event target.
         */
        const HIT_PAD = 6;
        /** Route prefix used when a row carries no explicit route (see routeOf). */
        const ROUTE_PREFIX = "opencode-go";
        /** Percent at or above which a window is called out in the warning color. */
        const WARN_PERCENT = 80;

        // Theme-aware styling through the DSH alias variables, so the panel follows the
        // active light/dark theme instead of hardcoding one surface color.
        const CSS = [
            ".dsw-ogu-wrap{position:relative;display:inline-flex;align-items:center}",
            ".dsw-ogu-chip{position:relative;z-index:2;pointer-events:auto;-webkit-app-region:no-drag;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;",
            "border:1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-secondary, inherit);",
            "font-size:12px;line-height:18px;cursor:pointer}",
            ".dsw-ogu-chip::after{content:\"\";position:absolute;inset:-4px 0}",
            ".dsw-ogu-chip > *{pointer-events:none}",
            ".dsw-ogu-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));color:var(--dsw-alias-label-primary, inherit)}",
            ".dsw-ogu-dot{width:6px;height:6px;border-radius:999px;flex:0 0 auto}",
            ".dsw-ogu-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary, #22c55e)}",
            ".dsw-ogu-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary, #f59e0b)}",
            ".dsw-ogu-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary, #ef4444)}",
            ".dsw-ogu-panel{position:absolute;bottom:calc(100% + 6px);right:0;z-index:60;width:max-content;max-height:min(60vh, 420px);overflow:auto;",
            "max-width:min(620px, calc(100vw - 32px));padding:12px 14px;border-radius:12px;",
            "border:1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35));",
            "background:var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #353638));pointer-events:auto;-webkit-app-region:no-drag;",
            "box-shadow:0 12px 32px var(--dsw-alias-bg-mask-2, rgba(0,0,0,.28));",
            "color:var(--dsw-alias-label-primary, inherit);font-size:12px;line-height:18px}",
            ".dsw-ogu-title{font-weight:600;color:var(--dsw-alias-label-primary, inherit);margin-bottom:8px}",
            ".dsw-ogu-table{border-collapse:collapse;font-variant-numeric:tabular-nums}",
            ".dsw-ogu-table th{color:var(--dsw-alias-label-tertiary, inherit);font-weight:500;text-align:right;",
            "padding:2px 8px;white-space:nowrap}",
            ".dsw-ogu-table th:first-child,.dsw-ogu-table td:first-child{text-align:left}",
            ".dsw-ogu-table th:nth-child(2),.dsw-ogu-table td:nth-child(2){text-align:left}",
            ".dsw-ogu-table td{color:var(--dsw-alias-label-secondary, inherit);text-align:right;padding:4px 8px;white-space:nowrap}",
            ".dsw-ogu-table td:first-child{color:var(--dsw-alias-label-primary, inherit)}",
            ".dsw-ogu-table td[data-warn=true]{color:var(--dsw-alias-state-warn-label, #f59e0b);font-weight:600}",
            ".dsw-ogu-table tr[data-active=true] td{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))}",
            ".dsw-ogu-table tr[data-active=true] td:first-child{font-weight:600}",
            ".dsw-ogu-meta{margin-top:8px;color:var(--dsw-alias-label-caption, inherit);font-size:11px}",
            ".dsw-ogu-error{margin-top:6px;color:var(--dsw-alias-state-error-primary, #ef4444);font-size:11px;word-break:break-all}"
        ].join("");

        const STYLE_TAG_ID = "dsh-opencode-go-usage/panel.css";
        function ensureStyles() {
            if (typeof document === "undefined") return;
            if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]") !== null) return;
            const tag = document.createElement("style");
            tag.dataset.plugin = "dsh-opencode-go-usage";
            tag.dataset.pluginCss = STYLE_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        function windowText(entry) {
            if (!entry) return "—";
            if (typeof entry.percent !== "number") return entry.status || "—";
            return entry.percent + "%";
        }

        function percentOf(entry) {
            return entry && typeof entry.percent === "number" ? entry.percent : null;
        }

        function whenText(iso) {
            if (!iso) return "—";
            const date = new Date(iso);
            if (Number.isNaN(date.getTime())) return "—";
            const pad = (value) => String(value).padStart(2, "0");
            return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
        }

        function useUsage() {
            const [state, setState] = react.useState({ payload: null, error: null });
            react.useEffect(() => {
                let alive = true;
                const load = async () => {
                    try {
                        const response = await fetch(ROUTE, { headers: { accept: "application/json" } });
                        if (!response.ok) throw new Error("HTTP " + response.status);
                        const payload = await response.json();
                        if (alive) setState({ payload, error: null });
                    } catch (error) {
                        if (alive) {
                            setState((previous) => ({
                                payload: previous.payload,
                                error: String((error && error.message) || error)
                            }));
                        }
                    }
                };
                load();
                const timer = window.setInterval(load, POLL_MS);
                return () => {
                    alive = false;
                    window.clearInterval(timer);
                };
            }, []);
            return state;
        }

        function percentCell(entry) {
            const percent = percentOf(entry);
            const warn = percent !== null && percent >= WARN_PERCENT;
            return h("td", warn ? { "data-warn": "true" } : null, windowText(entry));
        }

        /** Store reader used when a host surface does not pass the sessions store. */
        const fallbackUseSessions = () => undefined;

        function worstOf(accounts, window) {
            let worst = null;
            for (const row of accounts) {
                const percent = percentOf(row[window]);
                if (percent === null) continue;
                if (worst === null || percent > worst.percent) worst = { percent, account: row.account };
            }
            return worst;
        }

        /**
         * Route a row belongs to: the host sends `route` explicitly; without it (older host
         * build, before the next harness restart) the trailing number of the credential
         * reference is used, which is how this deployment names its routes.
         */
        function routeOf(row) {
            if (row.route) return { route: row.route, derived: false };
            const match = /(\d+)\s*$/.exec(row.account || "");
            return match ? { route: ROUTE_PREFIX + "-" + match[1], derived: true } : null;
        }

        function selectedRoute(accounts, provider) {
            if (!provider) return null;
            for (const row of accounts) {
                const found = routeOf(row);
                if (found && found.route === provider) return { row: row, route: found.route, derived: found.derived };
            }
            return null;
        }

        /** "opencode-go-2" -> "2"; the model picker labels providers with the same number. */
        function routeLabel(route) {
            const match = /(\d+)\s*$/.exec(route || "");
            return match ? match[1] : route;
        }

        function AccountRows({ accounts, activeAccount }) {
            const rows = accounts.map((row) => h("tr", {
                key: row.account,
                "data-active": row.account === activeAccount ? "true" : null
            },
                h("td", null, (row.account === activeAccount ? "▸ " : "") + row.account),
                h("td", null, row.key || "—"),
                percentCell(row.rolling),
                percentCell(row.weekly),
                percentCell(row.monthly),
                h("td", null, whenText(row.weekly && row.weekly.resetsAt))
            ));
            return h("table", { className: "dsw-ogu-table" },
                h("thead", null,
                    h("tr", null,
                        h("th", null, "账号"),
                        h("th", null, "Key"),
                        h("th", null, "5 小时"),
                        h("th", null, "周"),
                        h("th", null, "月"),
                        h("th", null, "周重置")
                    )
                ),
                h("tbody", null, ...rows)
            );
        }

        /** Read one primitive out of the shared model-directory snapshot store. */
        function useDirectoryProvider(directory) {
            const subscribe = react.useCallback((notify) => (directory ? directory.subscribe(notify) : () => {}), [directory]);
            const snapshot = react.useCallback(() => {
                if (!directory) return null;
                const value = directory.getSnapshot();
                return value && value.current ? value.current.provider : null;
            }, [directory]);
            return react.useSyncExternalStore(subscribe, snapshot, snapshot);
        }

        function OpenCodeUsageAction({ sessionId, useSessions, directory }) {
            const state = useUsage();
            const [open, setOpen] = react.useState(false);
            const wrapRef = react.useRef(null);
            const swallowedRef = react.useRef(false);

            // The composer surfaces pass the sessions store; without it the chip falls back to
            // the highest usage across accounts.
            const readSessions = typeof useSessions === "function" ? useSessions : fallbackUseSessions;
            const selection = readSessions((store) => (sessionId && store && store.byId
                ? store.byId[sessionId]?.projectionValues?.modelSelection
                : undefined));
            // `pending` is the model the composer has selected but not used yet; reading only
            // `lastUsed` would leave the chip on the previous account until the next turn.
            const chosen = selection ? (selection.pending ?? selection.lastUsed) : null;
            // The model-directory store holds the composer's live selection, so the chip follows
            // a switch immediately; the session projection only lands after the host round trip.
            const liveProvider = useDirectoryProvider(directory);
            const provider = liveProvider || (chosen && chosen.provider ? chosen.provider : null);

            const toggle = () => setOpen((value) => !value);

            // Capture-phase hit test: works even when another element sits on top of the chip,
            // because the decision uses the chip rect, not the event target.
            react.useEffect(() => {
                const onDocumentClick = (event) => {
                    const node = wrapRef.current;
                    if (!node) return;
                    const rect = node.getBoundingClientRect();
                    const inside = event.clientX >= rect.left - HIT_PAD && event.clientX <= rect.right + HIT_PAD
                        && event.clientY >= rect.top - HIT_PAD && event.clientY <= rect.bottom + HIT_PAD;
                    if (!inside) return;
                    swallowedRef.current = true;
                    window.setTimeout(() => { swallowedRef.current = false; }, 0);
                    toggle();
                };
                document.addEventListener("click", onDocumentClick, true);
                return () => document.removeEventListener("click", onDocumentClick, true);
            }, []);

            const accounts = state.payload && Array.isArray(state.payload.accounts) ? state.payload.accounts : [];
            const picked = selectedRoute(accounts, provider);
            const active = picked ? picked.row : null;

            let headline;
            if (active) {
                headline = {
                    scope: routeLabel(picked.route),
                    rolling: percentOf(active.rolling),
                    weekly: percentOf(active.weekly),
                    monthly: percentOf(active.monthly)
                };
            } else {
                const weekly = worstOf(accounts, "weekly");
                const monthly = worstOf(accounts, "monthly");
                const rolling = worstOf(accounts, "rolling");
                headline = {
                    scope: null,
                    rolling: rolling ? rolling.percent : null,
                    weekly: weekly ? weekly.percent : null,
                    monthly: monthly ? monthly.percent : null,
                    sources: { rolling, weekly, monthly }
                };
            }

            let worst = 0;
            for (const value of [headline.rolling, headline.weekly, headline.monthly]) {
                if (typeof value === "number" && value > worst) worst = value;
            }
            const failures = accounts.filter((row) => row.error);
            const tone = state.error && !state.payload ? "error" : (failures.length > 0 || worst >= WARN_PERCENT ? "warn" : "ok");

            const parts = [];
            if (typeof headline.weekly === "number") parts.push("周 " + headline.weekly + "%");
            if (typeof headline.monthly === "number") parts.push("月 " + headline.monthly + "%");
            const label = (headline.scope ? "GO " + headline.scope + " · " : "GO ") + (parts.length > 0 ? parts.join(" · ") : "用量");

            const hint = active
                ? [
                    "在用 " + picked.route + "（" + active.account + "）",
                    "5 小时 " + windowText(active.rolling) + " · 周 " + windowText(active.weekly) + " · 月 " + windowText(active.monthly),
                    active.weekly && active.weekly.resetsAt ? "周重置 " + whenText(active.weekly.resetsAt) : null
                ].filter(Boolean).join("；")
                : (headline.sources && (headline.sources.weekly || headline.sources.monthly || headline.sources.rolling)
                    ? [
                        "未匹配到本会话选择的账号，显示全部账号的最高值",
                        headline.sources.rolling ? "5 小时 " + headline.sources.rolling.percent + "%（" + headline.sources.rolling.account + "）" : null,
                        headline.sources.weekly ? "周 " + headline.sources.weekly.percent + "%（" + headline.sources.weekly.account + "）" : null,
                        headline.sources.monthly ? "月 " + headline.sources.monthly.percent + "%（" + headline.sources.monthly.account + "）" : null
                    ].filter(Boolean).join("；")
                    : "OpenCode Go 用量");

            return h("span", { className: "dsw-ogu-wrap", ref: wrapRef },
                h("button", {
                    type: "button",
                    className: "dsw-ogu-chip",
                    title: hint,
                    "data-active": active ? "true" : null,
                    onClick: () => {
                        if (swallowedRef.current) return;
                        toggle();
                    }
                },
                    h("span", { className: "dsw-ogu-dot", "data-tone": tone, "aria-hidden": true }),
                    h("span", null, label)
                ),
                open ? h("div", { className: "dsw-ogu-panel" },
                    h("div", { className: "dsw-ogu-title" }, "OpenCode Go 用量（5 小时 / 周 / 月）"),
                    h(AccountRows, { accounts, activeAccount: active ? active.account : null }),
                    failures.length > 0 ? h("div", { className: "dsw-ogu-error" },
                        failures.map((row) => row.account + ": " + row.error).join("；")) : null,
                    h("div", { className: "dsw-ogu-meta" },
                        state.payload && state.payload.sampledAt
                            ? "采样于 " + whenText(state.payload.sampledAt) + "，每 30 秒刷新；≥" + WARN_PERCENT + "% 标黄"
                                + (active ? "；▸ = " + (picked && picked.derived ? "按引用名尾号匹配的 " : "本会话选择的 ") + picked.route
                                    : (provider ? "；未找到 " + provider + " 对应的账号（按引用名尾号匹配）" : ""))
                            : "等待第一次采样…"),
                    state.error ? h("div", { className: "dsw-ogu-error" }, "读取失败：" + state.error) : null
                ) : null
            );
        }

        /** Client services required before the composer-row action can register. */
        const inject = ["slots", "modelDirectories"];

        function apply(ctx) {
            ensureStyles();
            const directories = ctx.modelDirectories;
            ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
                name: "conversation.input.right",
                id: "opencode-go-usage",
                order: 40,
                inject: (sessionId) => {
                    try {
                        const resolved = directories && sessionId !== void 0 ? directories.directoryFor(sessionId) : void 0;
                        return { sessionId: sessionId, directory: resolved ? resolved.store : void 0 };
                    } catch (error) {
                        return { sessionId: sessionId };
                    }
                }
            }, OpenCodeUsageAction));
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
