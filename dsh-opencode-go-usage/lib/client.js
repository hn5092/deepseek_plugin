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
            ".dsw-ogu-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:60;width:max-content;",
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

        function AccountRows({ accounts }) {
            const rows = accounts.map((row) => h("tr", { key: row.account },
                h("td", null, row.account),
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

        function OpenCodeUsageAction() {
            const state = useUsage();
            const [open, setOpen] = react.useState(false);
            const accounts = state.payload && Array.isArray(state.payload.accounts) ? state.payload.accounts : [];

            let worst = null;
            let failed = 0;
            for (const row of accounts) {
                if (row.error) failed += 1;
                const percent = percentOf(row.monthly);
                if (percent === null) continue;
                if (worst === null || percent > worst.percent) worst = { percent, account: row.account };
            }

            const tone = state.error && !state.payload ? "error" : (failed > 0 || (worst && worst.percent >= WARN_PERCENT) ? "warn" : "ok");
            const label = worst ? "GO " + worst.percent + "%" : "GO 用量";
            const hint = worst ? "月度额度最高：" + worst.account : "OpenCode Go 用量";
            const failures = accounts.filter((row) => row.error);

            return h("span", { className: "dsw-ogu-wrap" },
                h("button", {
                    type: "button",
                    className: "dsw-ogu-chip",
                    title: hint,
                    onClick: () => setOpen((value) => !value)
                },
                    h("span", { className: "dsw-ogu-dot", "data-tone": tone, "aria-hidden": true }),
                    h("span", null, label)
                ),
                open ? h("div", { className: "dsw-ogu-panel" },
                    h("div", { className: "dsw-ogu-title" }, "OpenCode Go 用量（5 小时 / 周 / 月）"),
                    h(AccountRows, { accounts }),
                    failures.length > 0 ? h("div", { className: "dsw-ogu-error" },
                        failures.map((row) => row.account + ": " + row.error).join("；")) : null,
                    h("div", { className: "dsw-ogu-meta" },
                        state.payload && state.payload.sampledAt
                            ? "采样于 " + whenText(state.payload.sampledAt) + "，每 30 秒刷新；≥" + WARN_PERCENT + "% 标黄"
                            : "等待第一次采样…"),
                    state.error ? h("div", { className: "dsw-ogu-error" }, "读取失败：" + state.error) : null
                ) : null
            );
        }

        /** Client services required before the header action can register. */
        const inject = ["slots"];

        function apply(ctx) {
            ensureStyles();
            ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
                name: "conversation.session.header.actions",
                id: "opencode-go-usage",
                order: 40
            }, OpenCodeUsageAction));
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});