/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — the verification path.
 *
 * Verify never parses the signed payload out of the message: it *rebuilds* it
 * from the live message (author, channel, id, content) plus the timestamp in
 * the footer, and asks the backend whether the signature covers exactly that.
 * Anything that shifted — a different author, a different channel, an edit,
 * a replayed footer — produces a different payload and therefore fails.
 */

import { getBackend } from "./crypto/backend";
import { extractFooter } from "./crypto/footer";
import { inflate, isCompact, isRawPacket, signerFingerprint } from "./crypto/packet";
import { buildPayload, canonicalizeContent, contentHash, snowflakeToMs } from "./crypto/payload";
import { settings } from "./settings";
import { getCached, getPeerBySigner, normalizeFingerprint, peersForUser, putCached, signerFingerprintsOf } from "./store";
import type { PinnedPeer, VerifyResult } from "./types";

/** Minimal shape of the Discord message object we depend on. */
export interface VerifiableMessage {
    id?: string;
    content: string;
    channel_id: string;
    author?: { id: string; };
    editedTimestamp?: { toString(): string; } | string | null;
}

const inFlight = new Map<string, Promise<VerifyResult>>();

function editedAtMs(message: VerifiableMessage): number | null {
    const raw = message.editedTimestamp;
    if (!raw) return null;
    const ms = Date.parse(String(raw));
    return Number.isFinite(ms) ? ms : null;
}

function result(status: VerifyResult["status"], hash: string, extra: Partial<VerifyResult> = {}): VerifyResult {
    return { status, contentHash: hash, checkedAt: Date.now(), ...extra };
}

/**
 * Verify a message. Safe to call on every render: results are cached by
 * message id and invalidated whenever the live content changes.
 */
export function verifyMessage(message: VerifiableMessage): VerifyResult | Promise<VerifyResult> {
    const hash = contentHash(message.content ?? "");

    if (!settings.store.verifyIncoming) return result("unsigned", hash);
    if (!message.content || !message.content.includes("‖dsig:1:")) return result("unsigned", hash);

    // The send race: our own message exists locally before it has a snowflake.
    // Report "pending" rather than flashing a red ✗ at the author.
    if (!message.id || !message.author?.id) return result("pending", hash);

    const cached = getCached(message.id, hash);
    if (cached) return cached;

    const key = `${message.id}:${hash}`;
    let pending = inFlight.get(key);
    if (!pending) {
        pending = verifyUncached(message, hash).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
    }
    return pending;
}

async function verifyUncached(message: VerifiableMessage, hash: string): Promise<VerifyResult> {
    let res: VerifyResult;
    try {
        res = await doVerify(message, hash);
    } catch (e) {
        res = result("error", hash, { detail: (e as Error).message });
    }
    if (message.id) putCached(message.id, res);
    return res;
}

async function doVerify(message: VerifiableMessage, hash: string): Promise<VerifyResult> {
    const footer = extractFooter(message.content);
    if (!footer) return result("unsigned", hash);

    const authorId = message.author!.id;
    const editedMs = editedAtMs(message);
    const mode = editedMs != null ? "e" : "o";
    const payload = buildPayload(
        mode,
        authorId,
        message.channel_id,
        mode === "e" ? message.id! : null,
        footer.signedTsMs,
        canonicalizeContent(footer.body)
    );

    // Which pinned keys are we allowed to test against? A raw packet names the
    // key that signed it, which is typically a *subkey* of a pinned peer.
    const declared = isRawPacket(footer.blob) ? signerFingerprint(footer.blob) : null;
    const candidates: PinnedPeer[] = declared
        ? [getPeerBySigner(declared)].filter(Boolean) as PinnedPeer[]
        : peersForUser(authorId);

    if (declared && candidates.length === 0) {
        return unknownSigner(hash, footer.signedTsMs, declared);
    }
    if (candidates.length === 0) {
        return unknownSigner(hash, footer.signedTsMs, undefined);
    }

    const backend = getBackend();
    let lastError: string | undefined;

    for (const peer of candidates) {
        // Compact blobs carry no issuer, so the fingerprint has to be supplied
        // to rebuild the packet: try each signing key this peer owns.
        const attempts = isCompact(footer.blob)
            ? signerFingerprintsOf(peer).map(fpr => ({ fpr, packet: inflate(footer.blob, fpr) }))
            : [{ fpr: declared ?? peer.fingerprint, packet: footer.blob }];

        for (const attempt of attempts) {
            const res = await backend.verify(payload, attempt.packet, peer.armoredPubkey);
            if (!res.good) {
                lastError = res.error;
                continue;
            }

            // The signature is sound. Was it really made by a key this peer owns?
            const signer = normalizeFingerprint(res.signerFpr ?? attempt.fpr);
            if (!signerFingerprintsOf(peer).includes(signer) && signer !== normalizeFingerprint(peer.fingerprint)) {
                lastError = "the signature was made by a key this peer does not own";
                continue;
            }
            // Is this key claimed for *this* account?
            if (peer.discordUserIds.length && !peer.discordUserIds.includes(authorId)) {
                return unknownSigner(hash, footer.signedTsMs, signer,
                    `${peer.label || "this key"} is not pinned to this account`);
            }

            return withSkewCheck(message, footer.signedTsMs, editedMs, hash, peer, signer);
        }
    }

    // Compact signatures do not name their signer, so "none of my pinned keys
    // verifies this" is genuinely ambiguous. Say so instead of overclaiming.
    const detail = declared
        ? lastError ?? "the signature does not match this message"
        : "no pinned key verifies this message — the signer may be unpinned, or the content changed";

    return result("invalid", hash, { signedTsMs: footer.signedTsMs, detail, fingerprint: declared ?? undefined });
}

function unknownSigner(hash: string, signedTsMs: number, fingerprint?: string, detail?: string): VerifyResult {
    if (!settings.store.verifyUnknownKeys) return result("unsigned", hash);
    return result("unknown-signer", hash, {
        signedTsMs,
        fingerprint,
        detail: detail ?? (fingerprint
            ? "this key is not in your pinned peers"
            : "no pinned peer keys to check against")
    });
}

/**
 * Timestamp model #3: the signed time must sit close to the time Discord
 * itself stamped the message. A valid signature with a drifting clock is a
 * warning, not an integrity failure.
 */
function withSkewCheck(
    message: VerifiableMessage,
    signedTsMs: number,
    editedMs: number | null,
    hash: string,
    peer: PinnedPeer,
    signerFpr: string
): VerifyResult {
    const reference = editedMs ?? snowflakeToMs(message.id!);
    const delta = Math.abs(signedTsMs - reference);
    const toleranceMs = Math.max(0, Number(settings.store.clockToleranceSec ?? 10)) * 1000;

    const base = {
        signedTsMs,
        snowflakeDeltaMs: delta,
        fingerprint: signerFpr,
        peerLabel: peer.label
    };

    if (delta > toleranceMs) {
        const detail = `signed time is ${(delta / 1000).toFixed(1)}s away from Discord's own timestamp`;
        return settings.store.onSkew === "fail"
            ? result("invalid", hash, { ...base, detail })
            : result("skew", hash, { ...base, detail });
    }

    return result("valid", hash, base);
}
