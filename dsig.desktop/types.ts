/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: GPG message signing for Vencord / Vesktop
 * Shared type definitions. Must stay dependency-free: this file is imported
 * from both the renderer and the main process.
 */

export type SignMode = "compact" | "armored";

/**
 * How the footer appears to someone *without* the plugin.
 *   plain    : a visible line of base64
 *   subtext  : the same line as Discord small text
 *   hidden   : a run of zero-width characters appended to the message,
 *              drawing nothing, for any message length
 */
export type FooterStyle = "plain" | "subtext" | "hidden";
export type BackendName = "gpg";

export type VerifyStatus =
    | "valid"
    | "invalid"
    | "skew"
    | "unknown-signer"
    | "unsigned"
    | "pending"
    | "error";

/** A (sub)key usable for signing, as reported by the backend. */
export interface KeyInfo {
    /** 40 hex chars, uppercase, no spaces. */
    fingerprint: string;
    /** "ed25519", "rsa4096", … */
    algo: string;
    /** Numeric OpenPGP public key algorithm (22 = EdDSA). */
    algoId: number;
    uids: string[];
    /** True when this key can create signatures. */
    canSign: boolean;
    /** True when the entry is a subkey rather than a primary key. */
    isSubkey: boolean;
    /** Unix seconds. */
    created: number;
    /** Unix seconds, 0 when the key does not expire. */
    expires: number;
}

export interface VerifyNativeResult {
    good: boolean;
    /** Fingerprint of the key that produced the signature, when known. */
    signerFpr?: string;
    /** Populated when the backend failed for a reason other than a bad signature. */
    error?: string;
}

export interface PinnedPeer {
    /** Primary key fingerprint: 40-hex, uppercase, no spaces. */
    fingerprint: string;
    /**
     * Every signing-capable key in this blob, primary and subkeys alike. A key
     * that signs with a subkey (the recommended setup) puts the *subkey's*
     * fingerprint in its signatures, so this is what the signer of a message is
     * actually matched against, and what the UI shows, since the primary's
     * algorithm says nothing about what does the signing.
     *
     * Optional for backwards compatibility; see `signingKeysOf()`.
     */
    signingKeys?: { fingerprint: string; algo: string; }[];
    /** @deprecated Pre-`signingKeys` shape, still read when present. */
    signingFingerprints?: string[];
    /** Algorithm of the *primary* key, which is often not the signing key. */
    algo: string;
    uids: string[];
    /** User-editable display name. */
    label: string;
    /** Discord accounts this key is claimed to belong to. */
    discordUserIds: string[];
    addedAt: number;
    armoredPubkey: string;
}

export interface VerifyResult {
    status: VerifyStatus;
    fingerprint?: string;
    /** Label of the pinned peer, when the signer is pinned. */
    peerLabel?: string;
    signedTsMs?: number;
    snowflakeDeltaMs?: number;
    /** Detail string for the badge tooltip (error reason, skew explanation, …). */
    detail?: string;
    checkedAt: number;
    /** Cheap hash of the live content; the cache entry is dropped when it changes. */
    contentHash: string;
}

/** Parsed ‖dsig footer. */
export interface ParsedFooter {
    /** Message body with the footer line removed. */
    body: string;
    signedTsMs: number;
    /** Raw bytes carried by the footer (compact blob or OpenPGP packet). */
    blob: Uint8Array;
    /** The literal footer line, including the leading ‖. */
    line: string;
}
