import z from "@deepseek-ai/schemastery";

/**
 * Cordis plugin name; the profile patch row id stays independent of it.
 *
 * This plugin is a pure client surface: it shows each Session row's short id and copies the full
 * one. It owns no state and registers no route, so the host half exists only to satisfy the
 * package manifest and to keep the loader entry explicit about what it carries.
 */
export const name = "session-id";

export const Config = z.object({});

export function apply() {
    // Nothing to mount: every bit of behaviour lives in lib/client.js, which the shell loads as
    // this package's `dsh.client` half.
}
