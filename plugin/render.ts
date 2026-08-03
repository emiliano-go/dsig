/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: render-time footer hiding.
 *
 * The footer is removed from the *rendered* node tree, not from the message
 * object: search, copy, quoting and every other plugin keep seeing the real
 * content, which is also what verification depends on.
 */

import { React } from "@webpack/common";

import { FOOTER_RE, HIDDEN_ALPHABET_RE_G } from "./crypto/footer";

const FOOTER_ANYWHERE = new RegExp(`\\n?${FOOTER_RE.source}`, "gm");

// Hidden footers draw nothing, so this is only about copying: the appended
// run of zero-width characters comes out. Variation selectors stay; a
// selector in rendered text is somebody's emoji presentation, not ours, and
// stripping it would change how a copied emoji pastes.
function stripString(s: string): string {
    return s.replace(FOOTER_ANYWHERE, "").replace(HIDDEN_ALPHABET_RE_G, "");
}

function walk(node: any): any {
    if (typeof node === "string") return stripString(node);
    if (Array.isArray(node)) {
        const next = node.map(walk);
        return next.every((n, i) => n === node[i]) ? node : next;
    }

    if (React.isValidElement(node)) {
        const children = (node.props as any)?.children;
        if (children == null) return node;
        const next = walk(children);
        return next === children ? node : React.cloneElement(node as any, undefined, next);
    }

    return node;
}

/**
 * Remove dsig footers from a rendered message content array.
 * Never throws: a render crash would take the whole message list with it.
 */
export function stripFooterNodes<T>(content: T): T {
    try {
        if (!Array.isArray(content)) return content;

        const stripped = content.map(walk);

        // Nothing matched: hand back the very same array so React can bail out
        // of re-rendering the message.
        if (stripped.every((node, i) => node === content[i])) return content;

        // Drop the empty strings and dangling line breaks the footer left behind.
        while (stripped.length) {
            const last = stripped[stripped.length - 1];
            if (last === "" || last === "\n" || last == null) stripped.pop();
            else break;
        }

        return stripped as unknown as T;
    } catch {
        return content;
    }
}
