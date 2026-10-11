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
        /** Route name of the CommandCode row; must match readCommandCodeRoute in lib/index.js. */
        const COMMANDCODE_ROUTE = "commandcode";
        /** Percent at or above which a window is called out in the warning color. */
        const WARN_PERCENT = 80;
        /** Smallest gap the open panel keeps to the viewport edge, in px. */
        const PANEL_MARGIN = 8;
        /** Layout effects run before paint, so the panel is placed without a visible jump. */
        const useLayoutEffect = react.useLayoutEffect || react.useEffect;

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
            // Fixed positioning: the panel is wider than the chip and opens upward, so anchoring it
            // to the chip alone pushed its left edge off-screen on a narrow window and the account
            // names plus the first columns were cut. The placement effect below clamps it instead.
            ".dsw-ogu-panel{position:fixed;z-index:60;width:max-content;max-height:min(60vh, 420px);overflow:auto;",
            "right:8px;bottom:8px;max-width:calc(100vw - 16px);padding:10px 12px;border-radius:12px;",
            "border:1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35));",
            // Opaque surface. --dsw-specific-menu resolves to var(--dsw-menu-surface-fill) on this
            // theme, a 58%-alpha fill meant to sit over a backdrop blur; using it alone let the
            // conversation show through the table. Paint an opaque layer-3 base and let the themed
            // menu fill tint it, so the panel stays readable on every theme.
            "background-color:var(--dsw-alias-bg-layer-3, #353638);",
            "background-image:linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent));",
            "pointer-events:auto;-webkit-app-region:no-drag;",
            "box-shadow:0 12px 32px var(--dsw-alias-bg-mask-2, rgba(0,0,0,.28));",
            "color:var(--dsw-alias-label-primary, inherit);font-size:12px;line-height:18px}",
            ".dsw-ogu-title{font-weight:600;color:var(--dsw-alias-label-primary, inherit);margin-bottom:8px}",
            ".dsw-ogu-table{border-collapse:collapse;font-variant-numeric:tabular-nums}",
            ".dsw-ogu-table th{color:var(--dsw-alias-label-tertiary, inherit);font-weight:500;text-align:right;",
            "padding:2px 6px;white-space:nowrap}",
            ".dsw-ogu-table th:first-child,.dsw-ogu-table td:first-child{text-align:left}",
            ".dsw-ogu-table th:nth-child(2),.dsw-ogu-table td:nth-child(2){text-align:left}",
            ".dsw-ogu-table td{color:var(--dsw-alias-label-secondary, inherit);text-align:right;padding:3px 6px;white-space:nowrap}",
            ".dsw-ogu-table td:first-child{color:var(--dsw-alias-label-primary, inherit)}",
            ".dsw-ogu-table td[data-warn=true]{font-weight:600}",
            ".dsw-ogu-table tr[data-active=true] td{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))}",
            ".dsw-ogu-table tr[data-active=true] td:first-child{font-weight:600}",
            // The footer is one long sentence. Left as a normal block its max-content width decided
            // the panel's width, so the panel stretched to the viewport cap and the table sat in a
            // mostly empty box (and the sentence itself was still cut off). `width:0;min-width:100%`
            // takes it out of the panel's intrinsic width while still filling it, so the panel is
            // sized by the table and the sentence wraps inside that width.
            ".dsw-ogu-meta{margin-top:8px;color:var(--dsw-alias-label-caption, inherit);font-size:11px;width:0;min-width:100%}",
            ".dsw-ogu-error{margin-top:6px;color:var(--dsw-alias-label-tertiary, #adb2b8);font-size:11px;line-height:16px;word-break:break-word;width:0;min-width:100%}"
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

        /** One decimal is plenty for a quota window; raw floats read as noise. */
        function round1(value) { return Math.round(value * 10) / 10; }

        function windowText(entry) {
            if (!entry) return "—";
            if (typeof entry.percent !== "number") return entry.status || "—";
            return round1(entry.percent) + "%";
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
            if (isCommandCode(row)) return { route: COMMANDCODE_ROUTE, derived: false };
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

        /** True for a row produced by the CommandCode reader (different columns apply). */
        function isCommandCode(row) {
            return row && row.source === "commandcode";
        }

        /** "$5.07 / $70 · 剩 $64.85" for a window that reports money, else the percent text. */
        function moneyText(entry) {
            if (!entry) return "—";
            const money = (value) => (typeof value === "number" ? "$" + value.toFixed(2) : null);
            const used = money(entry.used);
            const cap = money(entry.cap);
            if (used === null || cap === null) return windowText(entry);
            return used + " / " + cap;
        }

        /** Compact token count: 76203851 -> "76.2M". */
        function tokenText(value) {
            if (typeof value !== "number") return "—";
            if (value >= 1e9) return (value / 1e9).toFixed(1) + "B";
            if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
            if (value >= 1e3) return (value / 1e3).toFixed(1) + "K";
            return String(value);
        }

        /**
         * Short label for the account column. The chip already names an account by its route
         * number ("GO 7"), so the table uses the same label; the full credential reference is what
         * made the column wide and is kept in the cell tooltip instead.
         */
        function accountLabel(row) {
            const found = routeOf(row);
            const number = found ? /(\d+)\s*$/.exec(found.route) : null;
            return (isCommandCode(row) ? "CMD " : "GO ") + (number ? number[1] : "1");
        }

        function AccountRows({ accounts, activeAccount }) {
            // Both readers report window percentages, so every row uses the same percent
            // cells; the CommandCode money view stays available in the tooltip.
            const valueCell = (row, entry) => percentCell(entry);
            const rows = accounts.map((row) => h("tr", {
                key: row.account,
                "data-active": row.account === activeAccount ? "true" : null
            },
                h("td", { title: row.account }, (row.account === activeAccount ? "▸ " : "") + accountLabel(row)
                    + (isCommandCode(row) && row.planId ? " (" + row.planId.replace(/^individual-/, "") + ")" : "")),
                h("td", null, row.key || "—"),
                valueCell(row, row.rolling),
                valueCell(row, row.weekly),
                valueCell(row, row.monthly),
                h("td", null, whenText(row.weekly && row.weekly.resetsAt)),
                h("td", null, isCommandCode(row)
                    ? tokenText(row.tokensIn) + "→" + tokenText(row.tokensOut) + " · " + (typeof row.requests === "number" ? row.requests : "—")
                    : "—")
            ));
            return h("table", { className: "dsw-ogu-table" },
                h("thead", null,
                    h("tr", null,
                        h("th", null, "账号"),
                        h("th", null, "Key"),
                        h("th", null, "5 小时"),
                        h("th", null, "周"),
                        h("th", null, "月"),
                        h("th", null, "周重置"),
                        h("th", null, "Tokens入→出 · 请求")
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
            const panelRef = react.useRef(null);
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

            // Place the open panel inside the viewport. Right-aligning its edge to the chip is the
            // preferred position; when that would cross the left margin (the chip sits near the
            // left on a narrow window, and the table is wide) the panel is pinned to the margin
            // instead, so no column is clipped. It stays reachable while the window is resized or
            // the composer scrolls, and scrolls internally if the table still does not fit.
            useLayoutEffect(() => {
                if (!open) return;
                const place = () => {
                    const panel = panelRef.current;
                    const wrap = wrapRef.current;
                    if (!panel || !wrap) return;
                    const anchor = wrap.getBoundingClientRect();
                    const viewportWidth = window.innerWidth;
                    panel.style.maxWidth = (viewportWidth - PANEL_MARGIN * 2) + "px";
                    panel.style.bottom = (window.innerHeight - anchor.top + 6) + "px";
                    panel.style.right = (viewportWidth - anchor.right) + "px";
                    panel.style.left = "auto";
                    if (panel.getBoundingClientRect().left < PANEL_MARGIN) {
                        panel.style.left = PANEL_MARGIN + "px";
                        panel.style.right = "auto";
                    }
                };
                place();
                window.addEventListener("resize", place);
                window.addEventListener("scroll", place, true);
                return () => {
                    window.removeEventListener("resize", place);
                    window.removeEventListener("scroll", place, true);
                };
            }, [open]);

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
            if (typeof headline.weekly === "number") parts.push("周 " + round1(headline.weekly) + "%");
            if (typeof headline.monthly === "number") parts.push("月 " + round1(headline.monthly) + "%");
            const label = (headline.scope ? (active && isCommandCode(active) ? "CMD " : "GO ") + headline.scope + " · " : "GO ") + (parts.length > 0 ? parts.join(" · ") : "用量");

            const hint = active
                ? [
                    "在用 " + picked.route + "（" + active.account + "）",
                    isCommandCode(active) && active.planId ? "套餐 " + active.planId : null,
                    isCommandCode(active) ? "金额 5h " + moneyText(active.rolling) + " · 周 " + moneyText(active.weekly) + " · 月 " + moneyText(active.monthly) + (active.monthly && typeof active.monthly.remaining === "number" ? "（剩 $" + active.monthly.remaining.toFixed(2) + "）" : "") : null,
                    "5 小时 " + windowText(active.rolling) + " · 周 " + windowText(active.weekly) + " · 月 " + windowText(active.monthly),
                    isCommandCode(active) && typeof active.spend === "number" ? "本周期已花 $" + active.spend.toFixed(2) : null,
                    active.weekly && active.weekly.resetsAt ? "周重置 " + whenText(active.weekly.resetsAt) : null
                ].filter(Boolean).join("；")
                : (headline.sources && (headline.sources.weekly || headline.sources.monthly || headline.sources.rolling)
                    ? [
                        "未匹配到本会话选择的账号，显示全部账号的最高值",
                        headline.sources.rolling ? "5 小时 " + round1(headline.sources.rolling.percent) + "%（" + headline.sources.rolling.account + "）" : null,
                        headline.sources.weekly ? "周 " + round1(headline.sources.weekly.percent) + "%（" + headline.sources.weekly.account + "）" : null,
                        headline.sources.monthly ? "月 " + round1(headline.sources.monthly.percent) + "%（" + headline.sources.monthly.account + "）" : null
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
                open ? h("div", { className: "dsw-ogu-panel", ref: panelRef },
                    h("div", { className: "dsw-ogu-title" }, "用量（5 小时 / 周 / 月）· OpenCode Go + CommandCode"),
                    h(AccountRows, { accounts, activeAccount: active ? active.account : null }),
                    failures.length > 0 ? h("div", { className: "dsw-ogu-error" },
                        "⚠ " + failures.map((row) => row.account + " " + row.error).join("；")) : null,
                    h("div", { className: "dsw-ogu-meta" },
                        state.payload && state.payload.sampledAt
                            ? "采样于 " + whenText(state.payload.sampledAt) + "，面板每 30 秒刷新、后台每 30 分钟存一次历史；≥" + WARN_PERCENT + "% 标黄"
                                + "；Go 行为百分比，CMD 行为美元金额（已用/额度）"
                                + (active ? "；▸ = " + (picked && picked.derived ? "按引用名尾号匹配的 " : "本会话选择的 ") + picked.route
                                    : (provider ? "；未找到 " + provider + " 对应的账号（按引用名尾号匹配）" : ""))
                            : "等待第一次采样…"),
                    state.error ? h("div", { className: "dsw-ogu-error" }, "⚠ 读取失败 " + state.error) : null
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
