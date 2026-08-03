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
 *   hidden    a run of zero-width characters appended to the message, drawing nothing
 *
 * The last two exist for the *reader without the plugin*: subtext shrinks the
 * footer to a small grey line, hidden removes it from sight entirely.
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
    const line = `${FOOTER_MARK}dsig:1:${signedTsMs.toString(36)}:${toBase64(blob)}`;
    return style === "subtext" ? `-# ${line}` : line;
}

// ── the hidden form ──────────────────────────────────────────────
//
// A footer nobody without the plugin can see. The earlier mark-based designs
// were dead ends: Discord strips format characters, caps combining marks at
// four per base and ~90 per message, and a mark needs a real base character.
// A run of marks large enough to hold a signature never survived.
//
// The capacity probe (crypto/probe.ts) settled it with measurement. Zero-width
// *base* characters are not subject to the mark caps: a 600-character run of
// them came back byte for byte, in order. So the footer is a sequence of such
// characters, each drawn from a fixed alphabet, three bits apiece — data lives
// in *which* character appears, not in marks stacked on one.
//
// The alphabet is eight codepoints the probe returned at 16/16, all zero-width,
// none with joining or bidi behaviour that could disturb the visible text:
//
//   U+1160 U+115F U+FFA0  hangul fillers (Lo letters, inert)
//   U+2060               word joiner
//   U+2062               invisible times
//   U+200B U+200C        zero-width space / non-joiner
//   U+180E               mongolian vowel separator
//
// The run is appended after the message. It carries a magic byte, a version, a
// length and a CRC-8, so a stream damaged in transit reports itself as damaged
// instead of surfacing later as a signature that will not verify. There is no
// length floor: a one-character message, or a media message with no text at
// all, carries the whole signature in the appended run.

const HIDDEN_ALPHABET = "ᅠᅟﾠ⁠⁢​‌᠎";
/** 8 symbols → 3 bits each. */
const HIDDEN_BITS = 3;

const HIDDEN_MAGIC = 0xd5;
const HIDDEN_VERSION = 3;
/** Room for a millisecond timestamp until the year 10889. */
const TS_BYTES = 6;
/** magic, version, blob length, timestamp. */
const HEADER_BYTES = 3 + TS_BYTES;
/** Header + at least one blob byte + CRC, in symbols: the shortest real run. */
const MIN_SYMBOLS = Math.ceil(((HEADER_BYTES + 2) * 8) / HIDDEN_BITS);

const SYMBOL_INDEX = new Map<string, number>([...HIDDEN_ALPHABET].map((ch, i) => [ch, i]));

/** Everything the hidden footer is made of, for stripping it back out. Legacy
 *  variation selectors are included so an older message cleans up too. */
export const MARK_RE_G = /[︀-️]/g;
export const HIDDEN_ALPHABET_RE_G = new RegExp(`[${HIDDEN_ALPHABET}]`, "g");
export const HIDDEN_ANYWHERE_G = new RegExp(`[${HIDDEN_ALPHABET}\\uFE00-\\uFE0F]`, "g");
/** A run long enough to be ours, used to locate the footer in a message. */
const HIDDEN_RUN_RE_G = new RegExp(`[${HIDDEN_ALPHABET}]{${MIN_SYMBOLS},}`, "g");

/** CRC-8, enough to tell a damaged stream from an intact one. */
function crc8(bytes: ArrayLike<number>): number {
    let crc = 0xff;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
}

/** The framed byte stream a footer carries: header, blob, checksum. */
function frame(signedTsMs: number, blob: Uint8Array): Uint8Array {
    if (blob.length > 0xff) throw new Error("dsig: signature too large for an invisible footer");

    const bytes = new Uint8Array(HEADER_BYTES + blob.length + 1);
    bytes[0] = HIDDEN_MAGIC;
    bytes[1] = HIDDEN_VERSION;
    bytes[2] = blob.length;

    let ts = signedTsMs;
    for (let i = HEADER_BYTES - 1; i >= 3; i--) {
        bytes[i] = ts % 256;
        ts = Math.floor(ts / 256);
    }
    bytes.set(blob, HEADER_BYTES);
    bytes[bytes.length - 1] = crc8(bytes.subarray(0, bytes.length - 1));
    return bytes;
}

/** Bytes → invisible symbols, three bits per symbol, MSB first. */
function encodeSeq(bytes: Uint8Array): string {
    let out = "";
    let acc = 0;
    let bits = 0;
    for (const b of bytes) {
        acc = (acc << 8) | b;
        bits += 8;
        while (bits >= HIDDEN_BITS) {
            bits -= HIDDEN_BITS;
            out += HIDDEN_ALPHABET[(acc >> bits) & 0b111];
        }
    }
    if (bits > 0) out += HIDDEN_ALPHABET[(acc << (HIDDEN_BITS - bits)) & 0b111];
    return out;
}

/** Invisible symbols → bytes. Null when a symbol is not in the alphabet. */
function decodeSeq(run: string): Uint8Array | null {
    const bytes: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const ch of run) {
        const v = SYMBOL_INDEX.get(ch);
        if (v === undefined) return null;
        acc = (acc << HIDDEN_BITS) | v;
        bits += HIDDEN_BITS;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
        }
    }
    return Uint8Array.from(bytes);
}

/** Everything this format adds to a message, taken back off. */
export function stripHidden(raw: string): string {
    return raw.replace(HIDDEN_ANYWHERE_G, "");
}

/**
 * Append an invisible footer to `content`.
 *
 * Always succeeds, for a message of any length including none at all: the run
 * carries its own data and needs nothing from the message. Any stray footer
 * characters already present are removed first so they cannot corrupt the run.
 */
export function embedHidden(raw: string, signedTsMs: number, blob: Uint8Array): string {
    const content = stripHidden(raw);
    return content + encodeSeq(frame(signedTsMs, blob));
}

interface HiddenParse {
    signedTsMs?: number;
    blob?: Uint8Array;
    /** Bytes the sender said the signature has, when the header survived. */
    declaredLength?: number;
    /** Bytes actually recovered. */
    gotLength?: number;
    reason: string;
}

/** Read a hidden footer, saying what is wrong when there is something wrong. */
function parseHidden(raw: string): HiddenParse {
    HIDDEN_RUN_RE_G.lastIndex = 0;
    let match: RegExpExecArray | null;
    let run: string | null = null;
    // The longest run is ours; a stray alphabet character in the text is short.
    while ((match = HIDDEN_RUN_RE_G.exec(raw)) !== null)
        if (!run || match[0].length > run.length) run = match[0];
    if (run === null) return { reason: "no invisible run in the message" };

    const bytes = decodeSeq(run);
    if (!bytes) return { reason: "the run holds characters outside the alphabet" };
    if (bytes.length < HEADER_BYTES + 2) return { reason: `only ${bytes.length} bytes arrived, not even a header` };
    if (bytes[0] !== HIDDEN_MAGIC) return { reason: "the run does not start with the dsig marker" };
    if (bytes[1] !== HIDDEN_VERSION) return { reason: `footer version ${bytes[1]}, this build speaks ${HIDDEN_VERSION}` };

    const declaredLength = bytes[2];
    const framed = HEADER_BYTES + declaredLength + 1;
    const gotLength = Math.max(0, Math.min(bytes.length, framed) - HEADER_BYTES - 1);
    if (bytes.length < framed)
        return { declaredLength, gotLength, reason: `the signature was cut: ${gotLength} of ${declaredLength} bytes arrived` };

    const expectedCrc = bytes[framed - 1];
    if (crc8(bytes.subarray(0, framed - 1)) !== expectedCrc)
        return { declaredLength, gotLength: declaredLength, reason: "all bytes arrived but the checksum fails: something was altered" };

    let signedTsMs = 0;
    for (let i = 3; i < HEADER_BYTES; i++) signedTsMs = signedTsMs * 256 + bytes[i];
    if (!Number.isSafeInteger(signedTsMs) || signedTsMs <= 0)
        return { declaredLength, gotLength: declaredLength, reason: "the timestamp is not a real time" };

    return {
        signedTsMs,
        blob: bytes.subarray(HEADER_BYTES, HEADER_BYTES + declaredLength),
        declaredLength,
        gotLength: declaredLength,
        reason: "decodes"
    };
}

function decodeHidden(raw: string): { signedTsMs: number; blob: Uint8Array; } | null {
    const parsed = parseHidden(raw);
    return parsed.blob && parsed.signedTsMs ? { signedTsMs: parsed.signedTsMs, blob: parsed.blob } : null;
}

/**
 * What became of a hidden footer in transit, for the diagnostics panel: how
 * many symbols survived and whether the stream still decodes.
 */
export function hiddenReport(raw: string): {
    symbols: number;
    declaredLength?: number;
    gotLength?: number;
    reason: string;
} {
    const runs = raw.match(HIDDEN_RUN_RE_G) ?? [];
    const symbols = runs.reduce((n, run) => Math.max(n, run.length), 0);
    const parsed = parseHidden(raw);
    return { symbols, declaredLength: parsed.declaredLength, gotLength: parsed.gotLength, reason: parsed.reason };
}

/** True when the message carries a run long enough to be a hidden footer. */
export function hasHiddenRun(raw: string): boolean {
    return hiddenReport(raw).symbols > 0;
}


// ── parsing ──────────────────────────────────────────────────────

/** Append a footer to a message body, on its own line. */
export function attachFooter(content: string, signedTsMs: number, blob: Uint8Array, style: FooterStyle): string {
    return content + "\n" + encodeFooter(signedTsMs, blob, style);
}

// ── parsing ───────────────────────────────────────────────────────────────

/** True when the message carries a footer at all (cheap pre-check). */
export function hasFooter(raw: string): boolean {
    if (decodeHidden(raw)) return true;
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

/**
 * Pull the last footer out of a message. Returns null when there is none or
 * when it is malformed; a malformed footer is treated as "unsigned", never as
 * an error, so a stray line of text can't make the badge scream.
 */
export function extractFooter(raw: string): ParsedFooter | null {
    const found = lastLineFooter(raw);
    if (!found) {
        const hidden = decodeHidden(raw);
        if (!hidden) return null;
        // The hidden footer is a run appended to the text, so the body is the
        // message with that run (and any legacy selectors) taken back out.
        return { ...hidden, body: stripHidden(raw), line: "" };
    }

    // Also swallow the newline that separates the body from the footer.
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
        .replace(/\s+$/, "");
}
