window.__ModuleLoader__.load({
    id: "dsh-session-pins",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        const react = require("react");
        const { createRoot } = require("react-dom/client");
        const h = react.createElement;

        /** Diagnostics route registered by the host half. Holds no pin state. */
        const ROUTE = "/session-pins";
        /** Bumped whenever the browser half changes: the host echo tells which build a page runs. */
        const BUILD = "pins-3-native";
        /**
         * Slot outlet the area is injected next to. The renderer wraps every slot in
         * `<div data-slot="<key>">`, which is a stable hook; nothing here depends on the
         * hashed CSS-module class names of the widget that fills the slot.
         */
        const ANCHOR = '[data-slot="sidebar.workspaces"]';
        /** Marker attribute so the injected node is identifiable in devtools. */
        const HOST_ATTR = "data-dsh-session-pins";
        /** Below this width the sidebar is a collapsed rail: render nothing rather than a squashed block. */
        const MIN_WIDTH = 120;
        /** Candidates offered by the picker. */
        const MAX_CANDIDATES = 40;
        const EMPTY_SNAPSHOT = Object.freeze({ ids: Object.freeze([]), byId: Object.freeze({}), pinnedSessionIds: Object.freeze([]) });

        const CSS = [
            `.dsw-pins{padding:2px 8px 0;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}`,
            `.dsw-pins-head{display:flex;align-items:center;gap:6px;height:28px;padding:0 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}`,
            `.dsw-pins-head-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
            `.dsw-pins-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;cursor:pointer;flex:none}`,
            `.dsw-pins-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
            `.dsw-pins-row{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:8px;cursor:pointer;user-select:none}`,
            `.dsw-pins-row:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
            `.dsw-pins-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}`,
            `.dsw-pins-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
            `.dsw-pins-row[data-missing=true] .dsw-pins-title{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}`,
            `.dsw-pins-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}`,
            // The short Session id, so an external agent (Codex) can name the exact conversation.
            `.dsw-pins-id{flex:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;`,
            `color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:4px;padding:0 5px;cursor:copy}`,
            `.dsw-pins-id:hover{color:var(--dsw-alias-label-primary)}`,
            `.dsw-pins-id[data-copied=true]{color:var(--dsw-alias-state-business-primary, #4d6bfe)}`,
            `.dsw-pins-row:hover .dsw-pins-time{display:none}`,
            `.dsw-pins-remove{display:none;flex:none}`,
            `.dsw-pins-row:hover .dsw-pins-remove{display:inline-flex}`,
            `.dsw-pins-empty{padding:2px 8px 6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}`,
            `.dsw-pins-wrap{position:relative}`,
            // The picker must be OPAQUE. --dsw-specific-menu resolves to var(--dsw-menu-surface-fill)
            // on this theme, which is a 58%-alpha fill meant to sit over a blur; blur alone does not
            // stop the sidebar showing through, so the panel is painted in two layers instead:
            // an opaque layer-3 base, then the themed menu fill on top for its tint.
            `.dsw-pins-picker{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:60;max-height:min(50vh,360px);overflow:auto;padding:8px;border-radius:12px;`,
            `border:1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35));`,
            `background-color:var(--dsw-alias-bg-layer-3, #353638);`,
            `background-image:linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent));`,
            `box-shadow:0 12px 32px var(--dsw-alias-bg-mask-2, rgba(0,0,0,.28));color:var(--dsw-alias-label-primary)}`,
            `.dsw-pins-input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.45));`,
            `background:var(--dsw-alias-button-elevated-fill, transparent);color:inherit;font-size:13px;outline:none}`,
            `.dsw-pins-list{margin-top:6px;display:flex;flex-direction:column;gap:2px}`,
            `.dsw-pins-item{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px;border-radius:8px;cursor:pointer}`,
            `.dsw-pins-item:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
            `.dsw-pins-note{padding:6px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px}`,
            `.dsw-pins-error{padding:2px 8px 4px;color:var(--dsw-alias-state-error-primary, #ef4444);font-size:11px;line-height:16px;word-break:break-all}`,
            `.dsw-pins-chip{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:6px;background:transparent;`,
            `color:var(--dsw-alias-label-tertiary, inherit);cursor:pointer}`,
            `.dsw-pins-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary, inherit)}`,
            `.dsw-pins-chip[data-pinned=true]{color:var(--dsw-alias-state-business-primary, #4d6bfe)}`
        ].join("");

        const STYLE_TAG_ID = "dsh-session-pins/area.css";
        function ensureStyles() {
            if (typeof document === "undefined") return;
            if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]") !== null) return;
            const tag = document.createElement("style");
            tag.dataset.plugin = "dsh-session-pins";
            tag.dataset.pluginCss = STYLE_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        function messageOf(error) {
            return String((error && error.message) || error);
        }

        /**
         * Report one breadcrumb to the host half (readable from `GET <ROUTE>`). Diagnostics
         * must never break the UI, so every failure here is swallowed.
         */
        function note(message) {
            try {
                void fetch(ROUTE, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "note", note: String(message).slice(0, 200) })
                }).catch(() => {});
            } catch {
                // Ignored on purpose.
            }
        }

        /** Compact "2 分钟 / 3 小时 / 2 天" stamp, matching the session list's own style. */
        function whenText(at) {
            const value = Number(at);
            if (!Number.isFinite(value) || value <= 0) return "";
            const minutes = Math.floor((Date.now() - value) / 60000);
            if (minutes < 1) return "刚刚";
            if (minutes < 60) return minutes + " 分钟";
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + " 小时";
            const days = Math.floor(hours / 24);
            if (days < 30) return days + " 天";
            const date = new Date(value);
            const pad = (n) => String(n).padStart(2, "0");
            return pad(date.getMonth() + 1) + "-" + pad(date.getDate());
        }

        function PinIcon({ size }) {
            const pixels = size || 12;
            return h("svg", {
                width: pixels,
                height: pixels,
                viewBox: "0 0 16 16",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 1.5,
                strokeLinecap: "round",
                "aria-hidden": "true"
            }, h("circle", { cx: 8, cy: 6, r: 2.6 }), h("path", { d: "M8 8.6V14" }));
        }

        /** Session ids are `session-<uuid>`; the first uuid block is enough to name one. */
        function shortId(sessionId) {
            const raw = String(sessionId || "").replace(/^session-/, "");
            return raw.slice(0, 8);
        }

        /** Subscribe to one of the shell's snapshot stores without breaking React's identity rule. */
        function useSnapshotStore(store) {
            const subscribe = react.useCallback((listener) => {
                if (store && typeof store.subscribe === "function") return store.subscribe(listener);
                return () => {};
            }, [store]);
            const getSnapshot = react.useCallback(() => {
                try {
                    const snapshot = store && typeof store.getSnapshot === "function" ? store.getSnapshot() : null;
                    return snapshot || EMPTY_SNAPSHOT;
                } catch {
                    return EMPTY_SNAPSHOT;
                }
            }, [store]);
            return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        }

        /**
         * The shell owns pinning: `uiWorkspace.workspaces.list` is the authoritative snapshot and
         * `pinSession`/`unpinSession` the only writes. This plugin never stores a pin itself, so
         * the sidebar area, the row hover button and the row menu cannot disagree.
         */
        function pinStoreOf(workspace) {
            return workspace && workspace.workspaces && workspace.workspaces.list ? workspace.workspaces.list : null;
        }

        function usePinnedIds(workspace) {
            const snapshot = useSnapshotStore(pinStoreOf(workspace));
            const ids = snapshot && Array.isArray(snapshot.pinnedSessionIds) ? snapshot.pinnedSessionIds : EMPTY_SNAPSHOT.pinnedSessionIds;
            return ids;
        }

        /** Live session catalog from the shell: titles, recency, current selection. */
        function useSessions(sessions) {
            return useSnapshotStore(sessions && sessions.list);
        }

        /** Short id chip; clicking copies the full id so an external agent can be pointed at it. */
        function SessionIdChip({ sessionId, onCopy }) {
            const [copied, setCopied] = react.useState(false);
            return h("span", {
                className: "dsw-pins-id",
                "data-copied": copied ? "true" : null,
                title: "会话 ID：" + sessionId + "（点击复制）",
                onClick: (event) => {
                    event.stopPropagation();
                    let ok = false;
                    try {
                        void navigator.clipboard.writeText(sessionId);
                        ok = true;
                    } catch {
                        ok = false;
                    }
                    if (ok && typeof onCopy === "function") onCopy(sessionId);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                }
            }, copied ? "已复制" : shortId(sessionId));
        }

        /**
        * Pin toggle for the conversation header (a declared, session-scoped slot). Built by a
        * factory so the slot component closes over the live services instead of guessing at
        * props the slot never passes.
        * @param workspace - the `uiWorkspace` service that owns pin state.
        * @returns the slot component.
        */
        function makeHeaderAction(workspace) {
        return function PinHeaderAction({ sessionId }) {
            const pinnedIds = usePinnedIds(workspace);
            const pinned = pinnedIds.includes(sessionId);
            const [busy, setBusy] = react.useState(false);
            const [error, setError] = react.useState(null);
            const onClick = async () => {
                setBusy(true);
                try {
                    if (pinned) await workspace.unpinSession(sessionId);
                    else await workspace.pinSession(sessionId);
                    setError(null);
                } catch (failure) {
                    setError(messageOf(failure));
                } finally {
                    setBusy(false);
                }
            };
            const label = pinned ? "取消置顶" : "置顶这个会话";
            return h("button", {
                type: "button",
                className: "dsw-pins-chip",
                "data-pinned": pinned ? "true" : null,
                title: label + (error === null ? "" : "（失败：" + error + "）"),
                "aria-label": label,
                "aria-pressed": pinned,
                disabled: busy,
                onClick
            }, h(PinIcon, { size: 16 }));
        };
        }

        function PinnedArea({ sessions, workspace, collapsed }) {
            const snapshot = useSessions(sessions);
            const pinnedIds = usePinnedIds(workspace);
            const [pickerOpen, setPickerOpen] = react.useState(false);
            const [query, setQuery] = react.useState("");
            const [busy, setBusy] = react.useState(false);
            const [actionError, setActionError] = react.useState(null);
            const wrapRef = react.useRef(null);

            react.useEffect(() => {
                if (!pickerOpen) return;
                const onPointerDown = (event) => {
                    const node = wrapRef.current;
                    if (node && !node.contains(event.target)) setPickerOpen(false);
                };
                const onKeyDown = (event) => {
                    if (event.key === "Escape") setPickerOpen(false);
                };
                document.addEventListener("pointerdown", onPointerDown, true);
                document.addEventListener("keydown", onKeyDown, true);
                return () => {
                    document.removeEventListener("pointerdown", onPointerDown, true);
                    document.removeEventListener("keydown", onKeyDown, true);
                };
            }, [pickerOpen]);

            const byId = (snapshot && snapshot.byId) || {};
            const currentId = snapshot && snapshot.current && snapshot.current.id;

            const candidates = react.useMemo(() => {
                const ids = Array.isArray(snapshot && snapshot.ids) ? snapshot.ids : Object.keys(byId);
                const pinned = new Set(pinnedIds);
                const needle = query.trim().toLowerCase();
                return ids
                    .map((id) => ({ id, summary: byId[id] || {} }))
                    .filter((entry) => entry.summary.origin !== "subagent")
                    .filter((entry) => !pinned.has(entry.id))
                    .filter((entry) => needle.length === 0 || String(entry.summary.title || "").toLowerCase().includes(needle))
                    .sort((a, b) => (Number(b.summary.updatedAt) || 0) - (Number(a.summary.updatedAt) || 0))
                    .slice(0, MAX_CANDIDATES);
            }, [snapshot, pinnedIds, query, byId]);

            if (collapsed) return null;

            const open = (sessionId) => {
                try {
                    // Selection is owned by the workspace service; the session catalog has no `open`.
                    if (!workspace || typeof workspace.openSession !== "function") throw new Error("会话服务不可用");
                    workspace.openSession(sessionId);
                    setActionError(null);
                } catch (error) {
                    setActionError("打开会话失败：" + messageOf(error));
                }
            };

            const run = async (action, sessionId) => {
                setBusy(true);
                try {
                    if (!workspace) throw new Error("置顶服务不可用");
                    if (action === "pin") await workspace.pinSession(sessionId);
                    else await workspace.unpinSession(sessionId);
                    setActionError(null);
                    return true;
                } catch (error) {
                    setActionError((action === "pin" ? "置顶失败：" : "取消置顶失败：") + messageOf(error));
                    return false;
                } finally {
                    setBusy(false);
                }
            };

            const rows = pinnedIds.map((sessionId) => {
                const summary = byId[sessionId];
                return {
                    sessionId,
                    title: (summary && (summary.displayTitle || summary.title)) || "（未命名会话）",
                    missing: !summary,
                    updatedAt: (summary && summary.updatedAt) || 0
                };
            });

            return h("div", { className: "dsw-pins-wrap", ref: wrapRef },
                h("div", { className: "dsw-pins-head" },
                    h("span", { className: "dsw-pins-head-label" }, "置顶"),
                    h("button", {
                        type: "button",
                        className: "dsw-pins-icon",
                        title: "置顶一个会话",
                        "aria-label": "置顶一个会话",
                        onClick: () => { setPickerOpen((value) => !value); setQuery(""); }
                    }, h("span", { style: { fontSize: "14px", lineHeight: "14px" } }, pickerOpen ? "×" : "+"))
                ),
                rows.length === 0
                    ? h("div", { className: "dsw-pins-empty" }, "把常用会话置顶，随时点开 · " + BUILD)
                    : rows.map((row) => h("div", {
                        key: row.sessionId,
                        className: "dsw-pins-row",
                        "data-active": row.sessionId === currentId ? "true" : null,
                        "data-missing": row.missing ? "true" : null,
                        title: row.missing ? row.title + "（已不在会话列表中）" : row.title,
                        onClick: () => open(row.sessionId)
                    },
                        h("span", { style: { flex: "none", display: "inline-flex", color: "var(--dsw-alias-label-tertiary)" } }, h(PinIcon, { size: 12 })),
                        h("span", { className: "dsw-pins-title" }, row.title),
                        h(SessionIdChip, { sessionId: row.sessionId }),
                        h("span", { className: "dsw-pins-time" }, whenText(row.updatedAt)),
                        h("button", {
                            type: "button",
                            className: "dsw-pins-icon dsw-pins-remove",
                            title: "取消置顶",
                            "aria-label": "取消置顶",
                            disabled: busy,
                            onClick: (event) => {
                                event.stopPropagation();
                                void run("unpin", row.sessionId);
                            }
                        }, "×")
                    )),
                actionError !== null ? h("div", { className: "dsw-pins-error" }, actionError) : null,
                pickerOpen ? h("div", { className: "dsw-pins-picker" },
                    h("input", {
                        className: "dsw-pins-input",
                        type: "text",
                        placeholder: "搜索会话…",
                        value: query,
                        autoFocus: true,
                        onChange: (event) => setQuery(event.target.value)
                    }),
                    h("div", { className: "dsw-pins-list" },
                        candidates.length === 0
                            ? h("div", { className: "dsw-pins-note" }, "没有可置顶的会话")
                            : candidates.map((entry) => h("div", {
                                key: entry.id,
                                className: "dsw-pins-item",
                                title: entry.summary.title || entry.id,
                                onClick: async () => {
                                    const ok = await run("pin", entry.id);
                                    if (ok) setPickerOpen(false);
                                }
                            },
                                h("span", { className: "dsw-pins-title" }, entry.summary.displayTitle || entry.summary.title || "（未命名会话）"),
                                h("span", { className: "dsw-pins-id", title: entry.id }, shortId(entry.id)),
                                h("span", { className: "dsw-pins-time" }, whenText(entry.summary.updatedAt))
                            ))
                    )
                ) : null
            );
        }

        function apply(ctx) {
            ensureStyles();
            const sessions = ctx.get("sessions");
            // Pinning is a shell capability: the workspace service owns the state and the writes.
            const workspace = ctx.get("uiWorkspace");

            let container = null;
            let root = null;
            let collapsed = false;
            let frame = 0;
            let resize = null;

            const render = () => {
                if (root) root.render(h(PinnedArea, { sessions, workspace, collapsed }));
            };

            const attach = () => {
                const anchor = document.querySelector(ANCHOR);
                const parent = anchor && anchor.parentElement;
                if (!parent) return false;
                if (container === null) {
                    container = document.createElement("div");
                    container.setAttribute(HOST_ATTR, "1");
                    root = createRoot(container);
                    render();
                    if (typeof ResizeObserver === "function") {
                        resize = new ResizeObserver((entries) => {
                            const width = (entries[0] && entries[0].contentRect && entries[0].contentRect.width) || 0;
                            const next = width < MIN_WIDTH;
                            if (next !== collapsed) {
                                collapsed = next;
                                render();
                            }
                        });
                        resize.observe(container);
                    }
                }
                if (container.parentElement !== parent || container.nextElementSibling !== anchor) {
                    parent.insertBefore(container, anchor);
                }
                return true;
            };

            // The sidebar may mount after this plugin, and React can replace the outlet on a
            // re-render; re-attach when the node drops out instead of assuming one shot.
            const schedule = () => {
                if (frame !== 0) return;
                frame = window.requestAnimationFrame(() => {
                    frame = 0;
                    if (container === null || !container.isConnected) attach();
                });
            };

            attach();
            const observer = new MutationObserver(schedule);
            observer.observe(document.body, { childList: true, subtree: true });
            let attempts = 0;
            const retry = window.setInterval(() => {
                attempts += 1;
                if (container !== null && container.isConnected) {
                    window.clearInterval(retry);
                    return;
                }
                if (attempts > 40) {
                    window.clearInterval(retry);
                    ctx.logger.warn("session-pins: sidebar anchor %s never appeared; the pinned area stays unmounted", ANCHOR);
                    return;
                }
                attach();
            }, 500);

            // The conversation header keeps its own toggle; the row hover button and the row menu
            // are the shell's own pin affordances, so this plugin adds no second copy of them.
            ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
                name: "conversation.session.header.actions",
                id: "session-pins",
                order: 40
            }, makeHeaderAction(workspace)));

            note("build " + BUILD + " applied: area=" + (container !== null && container.isConnected ? "mounted" : "pending") +
                " source=native headerSlot=" + (ctx.slots ? "on" : "off"));

            ctx.effect(() => () => {
                window.clearInterval(retry);
                if (frame !== 0) window.cancelAnimationFrame(frame);
                observer.disconnect();
                if (resize !== null) resize.disconnect();
                const mounted = root;
                root = null;
                if (mounted) {
                    try {
                        mounted.unmount();
                    } catch {
                        // Unmounting a root whose host node is already gone is not an error here.
                    }
                }
                if (container !== null) container.remove();
                container = null;
            }, "session-pins: sidebar area");
        }

        /** Client services required before the area can mount. */
        const inject = ["sessions", "slots", "uiWorkspace"];

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
