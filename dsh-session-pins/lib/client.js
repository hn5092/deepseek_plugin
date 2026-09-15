window.__ModuleLoader__.load({
    id: "dsh-session-pins",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        const react = require("react");
        const { createRoot } = require("react-dom/client");
        const h = react.createElement;

        /** Exact route registered by the host half; keep in sync with lib/index.js `path`. */
        const ROUTE = "/session-pins";
        /** Re-read the host document occasionally so two windows do not drift apart. */
        const POLL_MS = 30000;
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
        const EMPTY_SNAPSHOT = Object.freeze({ ids: Object.freeze([]), byId: Object.freeze({}) });

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
            `.dsw-pins-row:hover .dsw-pins-time{display:none}`,
            `.dsw-pins-remove{display:none;flex:none}`,
            `.dsw-pins-row:hover .dsw-pins-remove{display:inline-flex}`,
            `.dsw-pins-empty{padding:2px 8px 6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}`,
            `.dsw-pins-wrap{position:relative}`,
            `.dsw-pins-picker{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:60;max-height:min(50vh,360px);overflow:auto;padding:8px;border-radius:12px;`,
            `border:1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35));background:var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #353638));`,
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

        async function mutate(action, payload) {
            const response = await fetch(ROUTE, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action, ...payload })
            });
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error((body && body.error) || "HTTP " + response.status);
            return body;
        }

        // ---- shared pin state ----------------------------------------------------------
        // The pinned area, the conversation-header button and the row-menu item all read the
        // same list. The menu item is rendered outside React, so the last fetched document is
        // cached here and every mutation notifies the mounted readers.

        /** Id of the item appended to a session row's menu. */
        const PIN_ITEM_ID = "dsh-session-pins:toggle";
        let pinsCache = [];
        let externalError = null;
        const pinListeners = new Set();

        function notifyPinReaders() {
            for (const listener of [...pinListeners]) {
                try {
                    listener();
                } catch {
                    // One broken reader must not stop the others.
                }
            }
        }

        function reportActionError(message) {
            externalError = message;
            notifyPinReaders();
        }

        function acceptPins(pins) {
            pinsCache = Array.isArray(pins) ? pins : [];
            externalError = null;
        }

        async function togglePin(sessionId, title) {
            const pinned = pinsCache.some((pin) => pin.sessionId === sessionId);
            const body = await mutate(pinned ? "unpin" : "pin", { sessionId, title: title || "" });
            acceptPins(body && body.pins);
            notifyPinReaders();
            return !pinned;
        }

        /** Live session summary for an id, from the same store the sidebar reads. */
        function summaryOf(sessions, sessionId) {
            try {
                const store = sessions && sessions.list;
                const snapshot = store && typeof store.getSnapshot === "function" ? store.getSnapshot() : null;
                return (snapshot && snapshot.byId && snapshot.byId[sessionId]) || null;
            } catch {
                return null;
            }
        }

        // ---- session-row menu item -----------------------------------------------------
        // DSH declares no slot for the row menu: the workspace plugin hands a fixed `items`
        // array to the shared Menu primitive, so that module export is the only extension
        // point. Wrapping it keeps the native menu markup, and dispose restores it.

        /** Row whose menu the pointer most recently opened; the fallback when the anchor is unknown. */
        let lastPointerRow = null;

        function reactFiberOf(node) {
            for (const key of Object.keys(node)) {
                if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return node[key];
            }
            return null;
        }

        /** Walk the React tree above a row element looking for the session object it renders. */
        function sessionIdFromRow(row) {
            let fiber = reactFiberOf(row);
            let depth = 0;
            while (fiber && depth < 40) {
                const props = fiber.memoizedProps;
                if (props && typeof props === "object") {
                    for (const key of ["node", "session", "row"]) {
                        const candidate = props[key];
                        if (candidate && typeof candidate.id === "string" && candidate.id.length > 0) return candidate.id;
                    }
                }
                fiber = fiber.return;
                depth += 1;
            }
            return null;
        }

        /** The row a menu belongs to: its anchor trigger carries the row's aria-label. */
        function rowForMenuAnchor(anchor) {
            const label = anchor && anchor.props ? anchor.props["aria-label"] : void 0;
            if (typeof label === "string" && label.length > 0) {
                for (const button of document.querySelectorAll("button[aria-label]")) {
                    if (button.getAttribute("aria-label") !== label) continue;
                    const row = button.closest('[role="treeitem"]');
                    if (row) return row;
                }
            }
            if (lastPointerRow !== null && lastPointerRow.isConnected) return lastPointerRow;
            return null;
        }

        function patchSessionMenu(ctx, sessions) {
            let primitives;
            try {
                primitives = require("@deepseek-ai/dsh-client-ui-primitives");
            } catch (error) {
                ctx.logger.warn("session-pins: primitives module unavailable, no row-menu item: %s", messageOf(error));
                return null;
            }
            const original = primitives && primitives.Menu;
            if (typeof original !== "function") {
                ctx.logger.warn("session-pins: Menu primitive not found, no row-menu item");
                return null;
            }
            if (original.__dshSessionPins === true) return null;

            const Patched = function Menu(props) {
                const items = props && Array.isArray(props.items) ? props.items : null;
                // Only the session-row menu offers fork/archive; workspace rows keep their own.
                const isSessionMenu = items !== null && items.some((item) => item && (item.id === "fork" || item.id === "archive"));
                // Render the original as an element, never call it: it owns hooks, so calling it
                // here would move those hooks into this component's list.
                if (!isSessionMenu) return h(original, props);
                const row = rowForMenuAnchor(props.anchor);
                const sessionId = row === null ? null : sessionIdFromRow(row);
                const pinned = sessionId !== null && pinsCache.some((pin) => pin.sessionId === sessionId);
                const withPin = items.concat([{
                    id: PIN_ITEM_ID,
                    label: pinned ? "取消置顶" : "置顶",
                    icon: h(PinIcon, { size: 16 })
                }]);
                const onSelect = (id) => {
                    if (id !== PIN_ITEM_ID) {
                        if (typeof props.onSelect === "function") props.onSelect(id);
                        return;
                    }
                    if (typeof props.onClose === "function") props.onClose();
                    if (sessionId === null) {
                        reportActionError("置顶：没能识别这一行的会话，请用置顶区的「＋」");
                        return;
                    }
                    const summary = summaryOf(sessions, sessionId);
                    void togglePin(sessionId, (summary && summary.title) || (row && row.textContent) || "").catch((error) => {
                        reportActionError("置顶失败：" + messageOf(error));
                    });
                };
                return h(original, { ...props, items: withPin, onSelect });
            };
            Patched.__dshSessionPins = true;

            const onPointerDown = (event) => {
                const target = event.target;
                const row = target && target.closest ? target.closest('[role="treeitem"]') : null;
                if (row) lastPointerRow = row;
            };
            document.addEventListener("pointerdown", onPointerDown, true);
            primitives.Menu = Patched;
            return () => {
                document.removeEventListener("pointerdown", onPointerDown, true);
                if (primitives.Menu === Patched) primitives.Menu = original;
            };
        }

        /** Pin toggle for the conversation header (a declared, session-scoped slot). */
        function PinHeaderAction({ sessionId, useSessions }) {
            const [state, refresh] = usePins();
            const snapshot = typeof useSessions === "function" ? useSessions((value) => value) : null;
            const summary = snapshot && snapshot.byId ? snapshot.byId[sessionId] : null;
            const title = (summary && summary.title) || "";
            const pinned = state.pins.some((pin) => pin.sessionId === sessionId);
            const [busy, setBusy] = react.useState(false);
            const [error, setError] = react.useState(null);
            const onClick = async () => {
                setBusy(true);
                try {
                    const body = await mutate(pinned ? "unpin" : "pin", { sessionId, title });
                    acceptPins(body && body.pins);
                    await refresh();
                    notifyPinReaders();
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
        }

        /** Host half document (pins) with its own refresh, so a mutation is visible immediately. */
        function usePins() {
            const [state, setState] = react.useState({ pins: [], error: null, loaded: false });
            const refresh = react.useCallback(async () => {
                try {
                    const response = await fetch(ROUTE, { headers: { accept: "application/json" } });
                    if (!response.ok) throw new Error("HTTP " + response.status);
                    const body = await response.json();
                    acceptPins(body && body.pins);
                    setState({
                        pins: pinsCache,
                        error: (body && body.error) || null,
                        loaded: true
                    });
                } catch (error) {
                    setState((previous) => ({ ...previous, error: messageOf(error), loaded: true }));
                }
            }, []);
            react.useEffect(() => {
                let alive = true;
                const run = () => { if (alive) void refresh(); };
                const onShared = () => {
                    if (!alive) return;
                    // Another entry point (menu item, header button) changed the document.
                    run();
                    setState((previous) => ({ ...previous, sharedError: externalError }));
                };
                pinListeners.add(onShared);
                run();
                const timer = window.setInterval(run, POLL_MS);
                return () => {
                    alive = false;
                    pinListeners.delete(onShared);
                    window.clearInterval(timer);
                };
            }, [refresh]);
            return [state, refresh];
        }

        /** Live session catalog from the client session service (same store the sidebar reads). */
        function useSessions(sessions) {
            const store = sessions && sessions.list;
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

        function PinnedArea({ sessions, collapsed }) {
            const [state, refresh] = usePins();
            const snapshot = useSessions(sessions);
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
                const pinned = new Set(state.pins.map((pin) => pin.sessionId));
                const needle = query.trim().toLowerCase();
                return ids
                    .map((id) => ({ id, summary: byId[id] || {} }))
                    .filter((entry) => entry.summary.origin !== "subagent")
                    .filter((entry) => !pinned.has(entry.id))
                    .filter((entry) => needle.length === 0 || String(entry.summary.title || "").toLowerCase().includes(needle))
                    .sort((a, b) => (Number(b.summary.updatedAt) || 0) - (Number(a.summary.updatedAt) || 0))
                    .slice(0, MAX_CANDIDATES);
            }, [snapshot, state.pins, query, byId]);

            if (collapsed) return null;

            const open = (sessionId) => {
                try {
                    if (!sessions || typeof sessions.open !== "function") throw new Error("会话服务不可用");
                    sessions.open(sessionId);
                    setActionError(null);
                } catch (error) {
                    setActionError("打开会话失败：" + messageOf(error));
                }
            };

            const run = async (action, payload) => {
                setBusy(true);
                try {
                    await mutate(action, payload);
                    await refresh();
                    setActionError(null);
                    return true;
                } catch (error) {
                    setActionError((action === "pin" ? "置顶失败：" : "取消置顶失败：") + messageOf(error));
                    return false;
                } finally {
                    setBusy(false);
                }
            };

            const rows = state.pins.map((pin) => {
                const summary = byId[pin.sessionId];
                return {
                    sessionId: pin.sessionId,
                    title: (summary && summary.title) || pin.title || "（未命名会话）",
                    missing: !summary,
                    updatedAt: (summary && summary.updatedAt) || Date.parse(pin.pinnedAt) || 0
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
                    ? h("div", { className: "dsw-pins-empty" }, "把常用会话置顶，随时点开")
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
                        h("span", { className: "dsw-pins-time" }, whenText(row.updatedAt)),
                        h("button", {
                            type: "button",
                            className: "dsw-pins-icon dsw-pins-remove",
                            title: "取消置顶",
                            "aria-label": "取消置顶",
                            disabled: busy,
                            onClick: (event) => {
                                event.stopPropagation();
                                void run("unpin", { sessionId: row.sessionId });
                            }
                        }, "×")
                    )),
                actionError !== null ? h("div", { className: "dsw-pins-error" }, actionError) : null,
                state.error !== null ? h("div", { className: "dsw-pins-error" }, "置顶服务：" + state.error) : null,
                state.sharedError ? h("div", { className: "dsw-pins-error" }, state.sharedError) : null,
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
                            ? h("div", { className: "dsw-pins-note" }, state.loaded ? "没有可置顶的会话" : "正在读取会话…")
                            : candidates.map((entry) => h("div", {
                                key: entry.id,
                                className: "dsw-pins-item",
                                title: entry.summary.title || entry.id,
                                onClick: async () => {
                                    const ok = await run("pin", {
                                        sessionId: entry.id,
                                        title: String(entry.summary.title || ""),
                                        workspaceId: entry.summary.workspaceId || null
                                    });
                                    if (ok) setPickerOpen(false);
                                }
                            },
                                h("span", { className: "dsw-pins-title" }, entry.summary.title || "（未命名会话）"),
                                h("span", { className: "dsw-pins-time" }, whenText(entry.summary.updatedAt))
                            ))
                    )
                ) : null
            );
        }

        function apply(ctx) {
            ensureStyles();
            const sessions = ctx.get("sessions");

            let container = null;
            let root = null;
            let collapsed = false;
            let frame = 0;
            let resize = null;

            const render = () => {
                if (root) root.render(h(PinnedArea, { sessions, collapsed }));
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

            // The row-menu item and the conversation-header button: the menu is a patched
            // shared primitive (no slot exists for it), the header button is a declared slot.
            let unpatchMenu = null;
            try {
                unpatchMenu = patchSessionMenu(ctx, sessions);
            } catch (error) {
                ctx.logger.warn("session-pins: could not patch the row menu: %s", messageOf(error));
            }
            ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
                name: "conversation.session.header.actions",
                id: "session-pins",
                order: 40
            }, PinHeaderAction));

            ctx.effect(() => () => {
                window.clearInterval(retry);
                if (frame !== 0) window.cancelAnimationFrame(frame);
                observer.disconnect();
                if (resize !== null) resize.disconnect();
                if (typeof unpatchMenu === "function") {
                    try {
                        unpatchMenu();
                    } catch {
                        // Restoring an overwritten export is best effort.
                    }
                }
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
        const inject = ["sessions", "slots"];

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
