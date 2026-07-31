/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — the on-the-wire footer.
 *
 *   ‖dsig:1:{ts36}:{blob_b64}
 *
 * Only fields that cannot be recovered from the message itself travel: the
 * millisecond timestamp the signature commits to, and the signature blob.
 * Dependency-free.
 */

import type { ParsedFooter } from "../types";

/** U+2016 DOUBLE VERTICAL LINE. Rare enough in prose to be a safe sentinel. */
export const FOOTER_MARK = "‖";

export const FOOTER_RE = /^‖dsig:1:([0-9a-z]+):([A-Za-z0-9+/]+={0,2})$/m;
const FOOTER_RE_G = new RegExp(FOOTER_RE.source, "gm");

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
        out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
        out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
}

export function fromBase64(s: string): Uint8Array {
    const clean = s.replace(/=+$/, "");
    const out = new Uint8Array((clean.length * 3) >> 2);
    let acc = 0;
    let bits = 0;
    let o = 0;
    for (const ch of clean) {
        const v = B64.indexOf(ch);
        if (v < 0) throw new Error("dsig: invalid base64 in footer");
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (acc >> bits) & 0xff;
        }
    }
    return out.subarray(0, o);
}

export function encodeFooter(signedTsMs: number, blob: Uint8Array): string {
    return `${FOOTER_MARK}dsig:1:${signedTsMs.toString(36)}:${toBase64(blob)}`;
}

/** True when the message carries a footer at all (cheap pre-check). */
export function hasFooter(raw: string): boolean {
    return raw.includes(`${FOOTER_MARK}dsig:1:`) && FOOTER_RE.test(raw);
}

/**
 * Pull the last footer out of a message. Returns null when there is none or
 * when it is malformed — a malformed footer is treated as "unsigned", never as
 * an error, so a stray line of text can't make the badge scream.
 */
export function extractFooter(raw: string): ParsedFooter | null {
    FOOTER_RE_G.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((match = FOOTER_RE_G.exec(raw)) !== null) last = match;
    if (!last) return null;

    const signedTsMs = parseInt(last[1], 36);
    if (!Number.isSafeInteger(signedTsMs) || signedTsMs <= 0) return null;

    let blob: Uint8Array;
    try {
        blob = fromBase64(last[2]);
    } catch {
        return null;
    }
    if (blob.length === 0) return null;

    const start = last.index;
    const end = start + last[0].length;
    // Also swallow the newline that separates the body from the footer.
    const body = (raw.slice(0, start).replace(/\n$/, "") + raw.slice(end)).replace(/\n$/, "");

    return { body, signedTsMs, blob, line: last[0] };
}

/** Strip every dsig footer line from a string (used for display). */
export function stripFooters(raw: string): string {
    return raw.replace(new RegExp(`\\n?${FOOTER_RE.source}`, "gm"), "").replace(/\s+$/, "");
}
