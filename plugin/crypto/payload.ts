/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: canonical payload construction.
 *
 * Dependency-free on purpose: imported by the renderer, the main process and
 * the test suite. Do not add imports that are not part of the language.
 */

export const PAYLOAD_VERSION = "dsig-v1";

export type PayloadMode = "o" | "e";

const SNOWFLAKE_EPOCH = 1420070400000n;

/**
 * Normalise content to what Discord will store and hand back to us.
 *
 * Both the sign and verify paths call this, so the only hard requirement is
 * that it is idempotent and that its output is a fixed point of Discord's own
 * trimming. Every step below satisfies both.
 */
export function canonicalizeContent(content: string): string {
    return content
        .normalize("NFC")
        // Variation selectors are where the hidden footer lives, so they are
        // never part of what gets signed. Both sides drop them, which also
        // means an emoji presentation request cannot shift a signature.
        .replace(/[\uFE00-\uFE0F]/g, "")
        .replace(/\r\n?/g, "\n")
        // Discord keeps trailing spaces, but they are invisible and survive
        // round-trips inconsistently across clients; drop them on both sides.
        .replace(/[ \t]+$/gm, "")
        // Discord trims the message as a whole before storing it.
        .replace(/^\s+|\s+$/g, "");
}

function assertSnowflake(name: string, value: string): string {
    if (!/^\d{1,25}$/.test(value)) throw new Error(`dsig: ${name} is not a snowflake: ${value}`);
    return value;
}

/**
 * Build the canonical signed payload. Content always comes last so that it can
 * never be confused with a preceding field, which lets verify *reconstruct*
 * the payload instead of parsing it.
 *
 *   original: dsig-v1\no\n{author}\n{channel}\n{ts}\n{content}
 *   edited:   dsig-v1\ne\n{author}\n{channel}\n{messageId}\n{ts}\n{content}
 */
export function buildPayload(
    mode: PayloadMode,
    authorId: string,
    channelId: string,
    messageId: string | null,
    signedTsMs: number,
    content: string
): string {
    if (mode !== "o" && mode !== "e") throw new Error(`dsig: bad mode ${mode}`);
    if (!Number.isSafeInteger(signedTsMs) || signedTsMs <= 0)
        throw new Error(`dsig: bad timestamp ${signedTsMs}`);

    const fields = [
        PAYLOAD_VERSION,
        mode,
        assertSnowflake("author_id", authorId),
        assertSnowflake("channel_id", channelId)
    ];

    if (mode === "e") {
        if (!messageId) throw new Error("dsig: edit payload requires a message id");
        fields.push(assertSnowflake("message_id", messageId));
    }

    fields.push(String(signedTsMs));

    // Content is last and is the only field allowed to contain newlines.
    return fields.join("\n") + "\n" + content;
}

/** Milliseconds encoded in a Discord snowflake. */
export function snowflakeToMs(snowflake: string): number {
    return Number((BigInt(snowflake) >> 22n) + SNOWFLAKE_EPOCH);
}

/**
 * Fast, non-cryptographic hash (FNV-1a, 64 bit) used solely to invalidate the
 * verify cache when content changes. Never used for a security decision.
 */
export function contentHash(s: string): string {
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let i = 0; i < s.length; i++) {
        h = (h ^ BigInt(s.charCodeAt(i))) * prime & mask;
    }
    return h.toString(16).padStart(16, "0");
}

/** UTF-8 encode without depending on a runtime-specific Buffer. */
export function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}
