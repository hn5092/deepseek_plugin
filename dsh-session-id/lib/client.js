window.__ModuleLoader__.load({
    id: "dsh-session-id",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        const react = require("react");
        const h = react.createElement;

        /** Bumped whenever the browser half changes: lets a page tell which build it runs. */
        const BUILD = "session-id-1";

        const CSS = [
            // The id chip sits at the row's end, in the same action strip as the native
            // pin/archive buttons, so it appears on hover beside them.
            `.dsw-sid{display:inline-flex;align-items:center;height:18px;padding:0 5px;border:none;border-radius:4px;`,
            `font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;`,
            `color:var(--dsw-alias-label-tertiary, inherit);background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));`,
            `cursor:copy;flex:none;white-space:nowrap}`,
            `.dsw-sid:hover{color:var(--dsw-alias-label-primary, inherit)}`,
            `.dsw-sid[data-copied=true]{color:var(--dsw-alias-state-business-primary, #4d6bfe)}`,
            // The row menu entry keeps the primitive's row metrics.
            `.dsw-sid-menu{display:flex;align-items:center;gap:8px;width:100%}`
        ].join("");

        const STYLE_TAG_ID = "dsh-session-id/chip.css";
        function ensureStyles() {
            if (typeof document === "undefined") return;
            if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]") !== null) return;
            const tag = document.createElement("style");
            tag.dataset.plugin = "dsh-session-id";
            tag.dataset.pluginCss = STYLE_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        /** Session ids are `session-<uuid>`; the first uuid block is enough to name one. */
        function shortId(sessionId) {
            return String(sessionId || "").replace(/^session-/, "").slice(0, 8);
        }

        function copy(text) {
            try {
                void navigator.clipboard.writeText(text);
                return true;
            } catch {
                return false;
            }
        }

        /**
         * Hover button at the end of every Session row, beside the native pin and archive
         * buttons. Registered into `sidebar.workspaces.session.row.action`, which hands the row's
         * `sessionId` — no DOM scraping, so nothing depends on the shell's class hashes.
         * @param props - the slot's owner share: the row's Session identity and display title.
         * @returns one icon-sized button, or null when the row has no id.
         */
        function SessionIdRowAction({ sessionId }) {
            const [copied, setCopied] = react.useState(false);
            if (typeof sessionId !== "string" || sessionId.length === 0) return null;
            return h("button", {
                type: "button",
                className: "dsw-sid",
                "data-copied": copied ? "true" : null,
                title: "会话 ID：" + sessionId + "（点击复制）",
                "aria-label": "复制会话 ID " + shortId(sessionId),
                onClick: () => {
                    if (!copy(sessionId)) return;
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                }
            }, copied ? "已复制" : shortId(sessionId));
        }

        /**
         * The same value in the row's "..." menu, for anyone who looks there first. The menu
         * dismisses through the injected hook after acting, as the contract requires.
         * @param props - owner share plus the menu's open-state hook.
         * @returns one menuitem button.
         */
        function SessionIdMenuItem({ sessionId, useMenuOpenState }) {
            const [, setMenuOpen] = useMenuOpenState();
            if (typeof sessionId !== "string" || sessionId.length === 0) return null;
            return h("button", {
                type: "button",
                role: "menuitem",
                className: "dsw-sid-menu",
                onClick: () => {
                    copy(sessionId);
                    setMenuOpen(false);
                }
            }, h("span", { className: "dsw-sid" }, shortId(sessionId)), h("span", null, "复制会话 ID 完整值"));
        }

        function apply(ctx) {
            ensureStyles();

            // Both row seats receive the row's Session identity from the shell; a client plugin's
            // entry lands beside the shipped pin/rename/fork/archive entries by `order`.
            ctx.slots.inject("sidebar.workspaces.session.row.action", () => ctx.slots.register({
                name: "sidebar.workspaces.session.row.action",
                id: "dsh-session-id:row-chip",
                order: 300
            }, SessionIdRowAction));

            ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
                name: "sidebar.workspaces.session.menu.item",
                id: "dsh-session-id:menu-copy",
                order: 500
            }, SessionIdMenuItem));

            ctx.logger.info("dsh-session-id %s: row chip + menu entry registered", BUILD);
        }

        /** Client services required before the slot entries can register. */
        const inject = ["slots"];

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
