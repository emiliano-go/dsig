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
 *   hidden    variation selectors spread through the message, drawing nothing
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
// Three things were measured against the live client, and together they rule
// out every obvious design:
//
//   * format characters are stripped. U+2062, used as an anchor, never came
//     back in the stored message.
//   * combining marks are truncated to four per base character, which is
//     Discord's defence against zalgo text. A 72-byte signature needs about
//     150 marks; four survived.
//   * a mark needs a real base character. Hung off a space, the whole run was
//     dropped as a defective sequence.
//
// Marks therefore go on characters the message already has, four each, since
// every visible character is a base and a cluster of its own. Whatever will not
// fit rides on carriers appended afterwards: U+2800 BRAILLE PATTERN BLANK,
// which draws nothing and is an ordinary symbol rather than a format character
// or a conjoining jamo. A carrier costs one cell of width, so the fewer the
// better; a message of ~40 characters needs none at all.
//
// U+1160 HANGUL JUNGSEONG FILLER was tried as the carrier first, because it is
// zero-width. Its carriers came back but the marks did not decode, and the
// reason is not yet established: it is not grapheme merging and not NFC, both
// checked. `hiddenReport` exists to answer that from the next failure rather
// than from another guess.
//
// Carriers go after the message and never inside it. That is what makes this
// work for a message of any length, including a two-character one, and it
// leaves links, mentions, custom emoji and code spans untouched, which an
// earlier version that wrote marks into the text could not promise.

const VS_FIRST = 0xfe00;
const VS_LAST = 0xfe0f;
/** What Discord keeps on one base character. */
const MARKS_PER_BASE = 4;
const HIDDEN_MAGIC = 0xd5;
const HIDDEN_VERSION = 1;
/** Room for a millisecond timestamp until the year 10889. */
const TS_BYTES = 6;
/** magic, version, timestamp. */
const HEADER_BYTES = 2 + TS_BYTES;

/**
 * Draws nothing, is its own grapheme cluster, and is not a format character.
 * It does occupy one cell of width, which is the price of all three.
 */
const CARRIER = "\u2800";

/** The two selectors spelling HIDDEN_MAGIC; also the cheap "is this ours" test. */
const MAGIC_PAIR = "\ufe0d\ufe05";

export const MARK_RE_G = /[\uFE00-\uFE0F]/g;
/** Everything the hidden footer adds, for stripping it back out. */
export const HIDDEN_ANYWHERE_G = /\u2800[\uFE00-\uFE0F]*/g;

function marksFor(signedTsMs: number, blob: Uint8Array): string {
    const bytes = new Uint8Array(HEADER_BYTES + blob.length);
    bytes[0] = HIDDEN_MAGIC;
    bytes[1] = HIDDEN_VERSION;

    let ts = signedTsMs;
    for (let i = HEADER_BYTES - 1; i >= 2; i--) {
        bytes[i] = ts % 256;
        ts = Math.floor(ts / 256);
    }
    bytes.set(blob, HEADER_BYTES);

    let out = "";
    for (const b of bytes) out += String.fromCharCode(VS_FIRST + (b >> 4), VS_FIRST + (b & 0x0f));
    return out;
}

/**
 * Stretches of the message we must not write into: a mark inside a link,
 * mention, custom emoji or code span would break it for every reader.
 */
const PROTECTED_RE_G = /```[\s\S]*?```|`[^`\n]+`|<[^>\n]{1,64}>|(?:https?:\/\/|www\.)\S+/g;

/**
 * Can a selector sit after this codepoint without changing what is drawn?
 *
 * Astral codepoints are excluded: they are emoji and friends, where a selector
 * is a presentation request rather than a no-op, and splitting a surrogate pair
 * would corrupt the text outright.
 */
function isSafeBase(cp: number): boolean {
    if (cp > 0xffff || cp <= 0x20) return false;
    if (cp >= VS_FIRST && cp <= VS_LAST) return false;
    if (cp === 0x2800) return false;
    // BMP symbol and arrow blocks render as emoji on most platforms.
    if (cp >= 0x2190 && cp <= 0x2bff) return false;
    if (cp >= 0x3000 && cp <= 0x303f) return false;
    return true;
}

/** String offsets just after each character of the message that may carry marks. */
function slotsOf(text: string): number[] {
    const spans: Array<[number, number]> = [];
    PROTECTED_RE_G.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PROTECTED_RE_G.exec(text)) !== null) spans.push([match.index, match.index + match[0].length]);

    const slots: number[] = [];
    for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i)!;
        const width = cp > 0xffff ? 2 : 1;
        const guarded = spans.some(([from, to]) => i >= from && i < to);
        if (!guarded && isSafeBase(cp)) slots.push(i + width);
        i += width;
    }
    return slots;
}

/** Everything this format adds to a message, taken back off. */
export function stripHidden(raw: string): string {
    return raw.replace(HIDDEN_ANYWHERE_G, "").replace(MARK_RE_G, "");
}

/**
 * Hang a footer off the end of `content` as invisible carriers.
 *
 * Always succeeds: the carriers supply their own base characters, so the
 * message never has to be long enough for anything.
 */
export function embedHidden(raw: string, signedTsMs: number, blob: Uint8Array): string {
    // Marks already in the text would splice themselves into the stream and
    // shift every nibble after them. They are not signed content either (see
    // canonicalizeContent), so they come off here too.
    const content = stripHidden(raw);
    const marks = marksFor(signedTsMs, blob);

    // The message's own characters are free bases: they add no width and no
    // carriers. Fill those first, in order, then append carriers for the rest.
    let out = "";
    let cursor = 0;
    let at = 0;
    for (const slot of slotsOf(content)) {
        if (at >= marks.length) break;
        out += content.slice(cursor, slot) + marks.slice(at, at + MARKS_PER_BASE);
        cursor = slot;
        at += MARKS_PER_BASE;
    }
    out += content.slice(cursor);

    for (; at < marks.length; at += MARKS_PER_BASE)
        out += CARRIER + marks.slice(at, at + MARKS_PER_BASE);

    return out;
}

/** How many carriers a message of this length would need appending. */
export function carriersNeeded(content: string, blobBytes: number): number {
    const marks = 2 * (HEADER_BYTES + blobBytes);
    const onText = Math.min(slotsOf(stripHidden(content)).length * MARKS_PER_BASE, marks);
    return Math.ceil((marks - onText) / MARKS_PER_BASE);
}

/**
 * What became of a hidden footer in transit, for the diagnostics panel. Every
 * failure so far has been the client editing the sequence rather than the
 * encoding being wrong, so the useful thing to report is what survived.
 */
export function hiddenReport(raw: string): {
    carriers: number;
    marks: number;
    expected: number;
    longestRun: number;
    magicFound: boolean;
    reason: string;
} {
    const carriers = (raw.match(new RegExp(CARRIER, "g")) ?? []).length;
    const runs = raw.match(/[\uFE00-\uFE0F]+/g) ?? [];
    const marks = runs.reduce((n, run) => n + run.length, 0);
    const longestRun = runs.length ? Math.max(...runs.map(run => run.length)) : 0;
    const stream = runs.join("");
    const magicFound = stream.includes(MAGIC_PAIR);
    const expected = carriers * MARKS_PER_BASE;

    const reason = decodeHidden(raw) ? "decodes"
        : marks === 0 ? "every mark was stripped"
        : carriers > 0 && marks < expected ? `carriers kept, marks cut to ${marks} where ${expected} should ride on carriers alone`
        : !magicFound ? "marks survived but the header did not: the run was truncated"
        : longestRun > MARKS_PER_BASE ? `a run of ${longestRun} marks is over the cap`
        : "the marks are intact but decode to nothing valid";

    return { carriers, marks, expected, longestRun, magicFound, reason };
}

/** Inverse of `marksFor`; null for anything that is not a v1 hidden footer. */
function decodeHidden(raw: string): { signedTsMs: number; blob: Uint8Array; } | null {
    const run = (raw.match(MARK_RE_G) ?? []).join("");

    // A selector belonging to the text would shift every nibble; the magic
    // pair says where ours starts.
    const at = run.indexOf(MAGIC_PAIR);
    if (at < 0) return null;
    const body = run.slice(at);
    if (body.length % 2 !== 0 || body.length < 2 * (HEADER_BYTES + 1)) return null;

    const bytes: number[] = [];
    for (let i = 0; i < body.length; i += 2) {
        const hi = body.charCodeAt(i) - VS_FIRST;
        const lo = body.charCodeAt(i + 1) - VS_FIRST;
        if (hi < 0 || hi > 0xf || lo < 0 || lo > 0xf) return null;
        bytes.push((hi << 4) | lo);
    }
    if (bytes[1] !== HIDDEN_VERSION) return null;

    let signedTsMs = 0;
    for (let i = 2; i < HEADER_BYTES; i++) signedTsMs = signedTsMs * 256 + bytes[i];
    if (!Number.isSafeInteger(signedTsMs) || signedTsMs <= 0) return null;

    return { signedTsMs, blob: Uint8Array.from(bytes.slice(HEADER_BYTES)) };
}

// ── parsing ──────────────────────────────────────────────────────

/** Append a footer to a message body, on its own line. */
export function attachFooter(content: string, signedTsMs: number, blob: Uint8Array, style: FooterStyle): string {
    return content + "\n" + encodeFooter(signedTsMs, blob, style);
}

// ── parsing ───────────────────────────────────────────────────────────────

/** True when the message carries a footer at all (cheap pre-check). */
export function hasFooter(raw: string): boolean {
    if (raw.includes(MAGIC_PAIR) && decodeHidden(raw)) return true;
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
        const hidden = raw.includes(MAGIC_PAIR) ? decodeHidden(raw) : null;
        if (!hidden) return null;
        // The marks are scattered through the text rather than appended to it,
        // so the body is the message with every selector taken back out.
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
