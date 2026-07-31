/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: the on-the-wire footer.
 *
 * Only fields that cannot be recovered from the message itself travel: the
 * millisecond timestamp the signature commits to, and the signature blob.
 * Dependency-free.
 *
 * Three shapes go out, chosen by the sender; all three are always accepted:
 *
 *   plain     ‖dsig:1:{ts36}:{blob_b64}          own line
 *   subtext   -# ‖dsig:1:{ts36}:{blob_b64}       own line, Discord small text
 *   hidden    U+2062 + one invisible codepoint per byte, appended to the body
 *
 * The point of the last two is the *reader without the plugin*: subtext shrinks
 * the footer to a grey line, hidden removes it from view entirely.
 */

import type { FooterStyle, ParsedFooter } from "../types";

/** U+2016 DOUBLE VERTICAL LINE. Rare enough in prose to be a safe sentinel. */
export const FOOTER_MARK = "‖";

/** The `-# ` prefix is optional so a subtext footer parses like a plain one. */
export const FOOTER_RE = /^(?:-# )?‖dsig:1:([0-9a-z]+):([A-Za-z0-9+/]+={0,2})$/m;
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

export function encodeFooter(signedTsMs: number, blob: Uint8Array, style: FooterStyle = "plain"): string {
    if (style === "hidden") return encodeHidden(signedTsMs, blob);
    const line = `${FOOTER_MARK}dsig:1:${signedTsMs.toString(36)}:${toBase64(blob)}`;
    return style === "subtext" ? `-# ${line}` : line;
}

/**
 * Append a footer to a message body the way its style requires: line footers
 * need a newline, the hidden one must *not* get one or the message grows a
 * blank last line for everybody.
 */
export function attachFooter(content: string, signedTsMs: number, blob: Uint8Array, style: FooterStyle): string {
    const footer = encodeFooter(signedTsMs, blob, style);
    return style === "hidden" ? content + footer : content + "\n" + footer;
}

// ── the hidden form ───────────────────────────────────────────────────────
//
// One invisible codepoint per byte: 0x00–0x0F map to the variation selectors
// U+FE00–U+FE0F and 0x10–0xFF to the supplement at U+E0100–U+E01EF. Neither
// range draws anything of its own. U+2062 (INVISIBLE TIMES) marks the start,
// so the run can be found without scanning for selectors in ordinary text.

// Written as escapes on purpose: these characters are invisible in an editor.
const HIDDEN_MARK = "\u2062";
export const HIDDEN_RE = /\u2062[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/u;
const HIDDEN_RE_G = new RegExp(HIDDEN_RE.source, "gu");
const HIDDEN_VERSION = 1;
/** Room for a millisecond timestamp until the year 10889. */
const TS_BYTES = 6;

function byteToChar(b: number): string {
    return String.fromCodePoint(b < 0x10 ? 0xfe00 + b : 0xe0100 + (b - 0x10));
}

function charToByte(cp: number): number | null {
    if (cp >= 0xfe00 && cp <= 0xfe0f) return cp - 0xfe00;
    if (cp >= 0xe0100 && cp <= 0xe01ef) return cp - 0xe0100 + 0x10;
    return null;
}

function encodeHidden(signedTsMs: number, blob: Uint8Array): string {
    const bytes = new Uint8Array(1 + TS_BYTES + blob.length);
    bytes[0] = HIDDEN_VERSION;
    let ts = signedTsMs;
    for (let i = TS_BYTES; i >= 1; i--) {
        bytes[i] = ts % 256;
        ts = Math.floor(ts / 256);
    }
    bytes.set(blob, 1 + TS_BYTES);

    let out = HIDDEN_MARK;
    for (const b of bytes) out += byteToChar(b);
    return out;
}

/** Inverse of `encodeHidden`; null for anything that is not a v1 hidden run. */
function decodeHidden(run: string): { signedTsMs: number; blob: Uint8Array; } | null {
    const bytes: number[] = [];
    for (const ch of run.slice(HIDDEN_MARK.length)) {
        const b = charToByte(ch.codePointAt(0)!);
        if (b == null) return null;
        bytes.push(b);
    }
    if (bytes.length <= 1 + TS_BYTES || bytes[0] !== HIDDEN_VERSION) return null;

    let signedTsMs = 0;
    for (let i = 1; i <= TS_BYTES; i++) signedTsMs = signedTsMs * 256 + bytes[i];
    if (!Number.isSafeInteger(signedTsMs) || signedTsMs <= 0) return null;

    return { signedTsMs, blob: Uint8Array.from(bytes.slice(1 + TS_BYTES)) };
}

// ── parsing ───────────────────────────────────────────────────────────────

/** True when the message carries a footer at all (cheap pre-check). */
export function hasFooter(raw: string): boolean {
    if (raw.includes(HIDDEN_MARK)) return true;
    return raw.includes(`${FOOTER_MARK}dsig:1:`) && FOOTER_RE.test(raw);
}

interface Candidate {
    signedTsMs: number;
    blob: Uint8Array;
    line: string;
    /** Slice of `raw` to remove to recover the signed body. */
    start: number;
    end: number;
}

function lastLineFooter(raw: string): Candidate | null {
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

    return { signedTsMs, blob, line: last[0], start: last.index, end: last.index + last[0].length };
}

function lastHiddenFooter(raw: string): Candidate | null {
    if (!raw.includes(HIDDEN_MARK)) return null;
    HIDDEN_RE_G.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((match = HIDDEN_RE_G.exec(raw)) !== null) last = match;
    if (!last) return null;

    const decoded = decodeHidden(last[0]);
    if (!decoded) return null;

    return { ...decoded, line: last[0], start: last.index, end: last.index + last[0].length };
}

/**
 * Pull the last footer out of a message. Returns null when there is none or
 * when it is malformed; a malformed footer is treated as "unsigned", never as
 * an error, so a stray line of text can't make the badge scream.
 */
export function extractFooter(raw: string): ParsedFooter | null {
    const line = lastLineFooter(raw);
    const hidden = lastHiddenFooter(raw);
    const found = !line ? hidden : !hidden ? line : (hidden.start > line.start ? hidden : line);
    if (!found) return null;

    // Also swallow the newline that separates the body from a line footer; the
    // hidden form is appended with no separator at all.
    const body = (raw.slice(0, found.start).replace(/\n$/, "") + raw.slice(found.end)).replace(/\n$/, "");

    return { body, signedTsMs: found.signedTsMs, blob: found.blob, line: found.line };
}

/**
 * Remove the footers we appended, and only those: repeatedly drop a footer
 * that sits at the very end. A footer quoted inside the message is part of
 * what the user wrote and stays exactly where it is.
 *
 * This is what the sign path uses, so re-signing an edit replaces the old
 * footer instead of burying it in the signed body.
 */
export function stripTrailingFooters(raw: string): string {
    let out = raw;
    for (;;) {
        const trimmed = out.replace(/\s+$/, "");
        const found = extractFooter(trimmed);
        if (!found || !trimmed.endsWith(found.line)) return out;
        out = found.body;
    }
}

/** Strip every dsig footer from a string (used for display). */
export function stripFooters(raw: string): string {
    return raw
        .replace(new RegExp(`\\n?${FOOTER_RE.source}`, "gm"), "")
        .replace(HIDDEN_RE_G, "")
        .replace(/\s+$/, "");
}
