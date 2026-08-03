/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: the capacity probe.
 *
 * Whether an invisible footer can ever hold a real signature comes down to
 * which invisible codepoints Discord's sanitizer lets through, and in what
 * quantity. Guessing has cost three encodings so far; this measures instead.
 *
 * `buildProbe()` makes one message that carries every candidate at once,
 * bracketed by visible ASCII delimiters so each one is judged independently.
 * The user sends it anywhere, and `analyzeProbe()` reads back what Discord
 * stored: who survived, who was stripped, and what signature sizes the
 * surviving alphabet could carry.
 *
 * Pure logic, dependency-free, imported by the settings panel and the tests.
 */

export const PROBE_PREFIX = "dsigprobe1";

/** A codepoint under test and the role we would use it in. */
export interface Candidate {
    /** One ASCII letter, unique, used as the segment delimiter tag. */
    tag: string;
    /** The codepoint itself, as a string. */
    char: string;
    /** For the report. */
    name: string;
    /**
     * How the character would carry data.
     *   base: zero-width standalone character; data lives in sequences of them
     *   mark: combining mark ridden on a base character
     *   control: known behaviour, included to validate the measurement itself
     */
    role: "base" | "mark" | "control";
    /** True when the character occupies no horizontal space when rendered. */
    zeroWidth: boolean;
}

/** Repetitions per candidate: enough to see truncation, cheap enough to sum. */
export const REPEATS = 16;

export const CANDIDATES: Candidate[] = [
    // Base characters that draw no ink. `zeroWidth` means zero *advance
    // width* on a client without the plugin, which this probe cannot measure:
    // it is a property of other people's fonts, not of what the server keeps.
    // The hangul fillers are the cautionary tale: they survived 16/16 and drew
    // nothing, but they are letters, and fallback fonts give them a letter's
    // width; a v3 footer showed up as lines of blank space. Only format
    // controls are marked zero-width now, because for them it holds by
    // definition rather than by font.
    { tag: "a", char: "\u1160", name: "U+1160 hangul jungseong filler (letter: has advance width)", role: "base", zeroWidth: false },
    { tag: "b", char: "\u115F", name: "U+115F hangul choseong filler (letter: has advance width)", role: "base", zeroWidth: false },
    { tag: "c", char: "\u3164", name: "U+3164 hangul filler", role: "base", zeroWidth: false },
    { tag: "d", char: "\uFFA0", name: "U+FFA0 halfwidth hangul filler (halfwidth: has advance width)", role: "base", zeroWidth: false },
    { tag: "e", char: "\u17B4", name: "U+17B4 khmer vowel inherent aq (width varies by font)", role: "base", zeroWidth: false },
    { tag: "f", char: "\u17B5", name: "U+17B5 khmer vowel inherent aa (width varies by font)", role: "base", zeroWidth: false },

    // Format characters: zero-width by definition, no font involved.
    { tag: "g", char: "\u200B", name: "U+200B zero width space", role: "base", zeroWidth: true },
    { tag: "h", char: "\u200C", name: "U+200C zero width non-joiner", role: "base", zeroWidth: true },
    { tag: "i", char: "\u200D", name: "U+200D zero width joiner", role: "base", zeroWidth: true },
    { tag: "j", char: "\u2060", name: "U+2060 word joiner", role: "base", zeroWidth: true },
    { tag: "k", char: "\u2062", name: "U+2062 invisible times", role: "base", zeroWidth: true },
    { tag: "l", char: "\uFEFF", name: "U+FEFF zero width no-break space", role: "base", zeroWidth: true },
    { tag: "m", char: "\u061C", name: "U+061C arabic letter mark", role: "base", zeroWidth: true },
    { tag: "n", char: "\u180E", name: "U+180E mongolian vowel separator (a space before Unicode 6.3: width varies)", role: "base", zeroWidth: false },

    // Invisible combining marks beyond the 16 variation selectors. Every one
    // that survives widens the per-mark alphabet and its 4 bits per mark.
    { tag: "o", char: "\u034F", name: "U+034F combining grapheme joiner", role: "mark", zeroWidth: true },
    { tag: "p", char: "\u180B", name: "U+180B mongolian fvs one", role: "mark", zeroWidth: true },
    { tag: "q", char: "\u180C", name: "U+180C mongolian fvs two", role: "mark", zeroWidth: true },
    { tag: "r", char: "\u180D", name: "U+180D mongolian fvs three", role: "mark", zeroWidth: true },

    // Controls: outcomes already measured, so a probe that disagrees about
    // these is telling us the measurement itself is broken.
    { tag: "y", char: "\u2800", name: "U+2800 braille blank (control: survives, has width)", role: "control", zeroWidth: false }
];

/** Marks are ridden on a base character, "x", since bare marks are defective. */
const MARK_BASE = "x";

/** Single base character carrying 12 selectors: re-measures the per-base cap. */
const STACK_TAG = "S";
const STACK_MARKS = 12;

/** 30 bases with 4 selectors each: re-measures the ~90 total cap, precisely. */
const SPREAD_TAG = "T";
const SPREAD_BASES = 30;
const SPREAD_MARKS_EACH = 4;

function vs(n: number): string {
    return String.fromCharCode(0xfe00 + (n % 16));
}

function segment(tag: string, payload: string): string {
    return `[${tag}:${payload}]`;
}

/**
 * The probe message. Deterministic, so analysis needs only what came back.
 */
export function buildProbe(): string {
    let out = PROBE_PREFIX;

    for (const c of CANDIDATES) {
        const payload = c.role === "mark"
            ? MARK_BASE + c.char.repeat(REPEATS)
            : c.char.repeat(REPEATS);
        out += segment(c.tag, payload);
    }

    let stack = MARK_BASE;
    for (let i = 0; i < STACK_MARKS; i++) stack += vs(i);
    out += segment(STACK_TAG, stack);

    let spread = "";
    for (let i = 0; i < SPREAD_BASES; i++) {
        spread += MARK_BASE;
        for (let j = 0; j < SPREAD_MARKS_EACH; j++) spread += vs(i + j);
    }
    out += segment(SPREAD_TAG, spread);

    return out;
}

export function isProbe(content: string): boolean {
    return content.startsWith(PROBE_PREFIX);
}

export interface CandidateResult {
    name: string;
    role: Candidate["role"];
    zeroWidth: boolean;
    sent: number;
    survived: number;
    /** False when the segment's delimiters themselves did not come back. */
    segmentIntact: boolean;
}

export interface ProbeReport {
    results: CandidateResult[];
    /** Selectors kept on one heavily-stacked base (the per-base cap). */
    stackKept: number;
    stackSent: number;
    /** Selectors kept across 30 lightly-loaded bases (the total cap). */
    spreadKept: number;
    spreadSent: number;
    /** Surviving zero-width base characters: the alphabet for sequence coding. */
    survivingBases: string[];
    /** Surviving extra marks (beyond the 16 selectors). */
    survivingMarks: string[];
    /** Bits one character of sequence coding could carry, log2(alphabet). */
    bitsPerBaseChar: number;
    /** What those numbers mean for a real signature. */
    verdict: string;
}

function count(haystack: string, char: string): number {
    let n = 0;
    for (const ch of haystack) if (ch === char) n++;
    return n;
}

/** The payload between this tag's delimiters, or null if they were damaged. */
function segmentPayload(received: string, tag: string): string | null {
    const open = received.indexOf(`[${tag}:`);
    if (open < 0) return null;
    const close = received.indexOf("]", open);
    if (close < 0) return null;
    return received.slice(open + tag.length + 2, close);
}

/**
 * Read the survivors out of a probe that has been through Discord.
 *
 * Counting happens inside each segment's delimiters, so a candidate is judged
 * by its own segment even if other characters moved or vanished around it.
 */
export function analyzeProbe(received: string): ProbeReport {
    const results: CandidateResult[] = [];

    for (const c of CANDIDATES) {
        const payload = segmentPayload(received, c.tag);
        results.push({
            name: c.name,
            role: c.role,
            zeroWidth: c.zeroWidth,
            sent: REPEATS,
            survived: payload === null ? 0 : count(payload, c.char),
            segmentIntact: payload !== null
        });
    }

    const stackPayload = segmentPayload(received, STACK_TAG) ?? "";
    const spreadPayload = segmentPayload(received, SPREAD_TAG) ?? "";
    const isVs = (ch: string) => {
        const cp = ch.codePointAt(0)!;
        return cp >= 0xfe00 && cp <= 0xfe0f;
    };
    const stackKept = [...stackPayload].filter(isVs).length;
    const spreadKept = [...spreadPayload].filter(isVs).length;

    const survivingBases = CANDIDATES
        .filter((c, i) => c.role === "base" && c.zeroWidth && results[i].survived === REPEATS)
        .map(c => c.name);
    const survivingMarks = CANDIDATES
        .filter((c, i) => c.role === "mark" && results[i].survived === REPEATS)
        .map(c => c.name);

    const bitsPerBaseChar = survivingBases.length >= 2 ? Math.floor(Math.log2(survivingBases.length)) : survivingBases.length;

    // What would a compact signature need? 72 bytes plus ~10 of header.
    const NEEDED_BITS = (72 + 10) * 8;
    let verdict: string;
    if (survivingBases.length >= 2) {
        const chars = Math.ceil(NEEDED_BITS / bitsPerBaseChar);
        verdict = `${survivingBases.length} zero-width base characters survive: sequence coding carries `
            + `${bitsPerBaseChar} bit(s)/char, a signature needs ~${chars} invisible chars `
            + "(message limit 2000). Run the long-run probe to confirm runs of that length survive, "
            + "and check the result on a client without the plugin (or with Hide footer off): "
            + "this probe measures survival, not how other people's fonts render it.";
    } else if (survivingBases.length === 1) {
        verdict = "one zero-width base survives: sequences of a single character carry no data by "
            + "themselves, but combined with the 16 selectors as marks it may still work. "
            + "Run the long-run probe.";
    } else {
        const totalMarkBits = (spreadKept + stackKept) > 0 ? "the ~90-selector cap stands" : "no marks survive at all";
        verdict = `no zero-width base character survives and ${totalMarkBits}: `
            + "a 64-byte signature cannot travel invisibly. Subtext is the honest minimum.";
    }

    return {
        results,
        stackKept,
        stackSent: STACK_MARKS,
        spreadKept,
        spreadSent: SPREAD_BASES * SPREAD_MARKS_EACH,
        survivingBases,
        survivingMarks,
        bitsPerBaseChar,
        verdict
    };
}

// ── stage 2: the long-run probe ──────────────────────────────────

export const PROBE2_PREFIX = "dsigprobe2";
/** Long enough to prove a signature-sized run, ~600 chars of payload. */
export const PROBE2_RUN = 600;

/**
 * A long alternating run of the best survivors: stage 1 says a character
 * survives 16 deep, this asks whether it survives signature-length deep.
 */
export function buildProbe2(survivors: string[]): string {
    const alphabet = survivors.slice(0, 2);
    if (alphabet.length === 0) throw new Error("dsig: no surviving characters to stress-test");

    let run = "";
    for (let i = 0; i < PROBE2_RUN; i++) run += alphabet[i % alphabet.length];
    return `${PROBE2_PREFIX}[${run}]`;
}

export function isProbe2(content: string): boolean {
    return content.startsWith(PROBE2_PREFIX);
}

export interface Probe2Report {
    sent: number;
    survived: number;
    orderPreserved: boolean;
    verdict: string;
}

export function analyzeProbe2(received: string, survivors: string[]): Probe2Report {
    const alphabet = survivors.slice(0, 2);
    const open = received.indexOf("[");
    const close = received.lastIndexOf("]");
    const payload = open >= 0 && close > open ? received.slice(open + 1, close) : "";

    const kept = [...payload].filter(ch => alphabet.includes(ch));
    const expected: string[] = [];
    for (let i = 0; i < PROBE2_RUN; i++) expected.push(alphabet[i % alphabet.length]);

    const orderPreserved = kept.length === PROBE2_RUN && kept.every((ch, i) => ch === expected[i]);

    return {
        sent: PROBE2_RUN,
        survived: kept.length,
        orderPreserved,
        verdict: orderPreserved
            ? "the full run survived in order: invisible signatures are feasible, next step is the encoder"
            : kept.length === 0
                ? "long runs are stripped entirely even though short ones survive"
                : `${kept.length} of ${PROBE2_RUN} survived${kept.length ? ", order " + (orderPreserved ? "kept" : "NOT kept") : ""}: a signature would be cut`
    };
}
