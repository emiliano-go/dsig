/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: DataStore wrappers.
 *
 * Pinned peers and verify results are *data*, not config: they never go into
 * the (small, synced, hand-editable) settings JSON.
 */

import * as DataStore from "@api/DataStore";

import type { PinnedPeer, VerifyResult } from "./types";

const PEERS_KEY = "dsig:peers";
const CACHE_KEY = "dsig:verifyCache";

/** Keeping the cache bounded matters: channels scroll forever. */
const CACHE_LIMIT = 500;

let peers: Record<string, PinnedPeer> = {};
let peersLoaded = false;

const cache = new Map<string, VerifyResult>();
const listeners = new Set<() => void>();

export function onPeersChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    for (const fn of listeners) {
        try { fn(); } catch { /* a bad listener must not break the store */ }
    }
}

export function normalizeFingerprint(fpr: string): string {
    return fpr.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

export function groupFingerprint(fpr: string): string {
    return (normalizeFingerprint(fpr).match(/.{1,4}/g) ?? []).join(" ");
}

// ── peers ─────────────────────────────────────────────────────────────────

export async function loadPeers(): Promise<Record<string, PinnedPeer>> {
    peers = (await DataStore.get<Record<string, PinnedPeer>>(PEERS_KEY)) ?? {};
    peersLoaded = true;
    emit();
    return peers;
}

/** Synchronous view of the peer list; empty until loadPeers() has run. */
export function getPeers(): PinnedPeer[] {
    return Object.values(peers);
}

export function getPeer(fingerprint: string): PinnedPeer | undefined {
    return peers[normalizeFingerprint(fingerprint)];
}

/**
 * Keys that may appear as the signer of a message from this peer: the signing
 * subkeys, or the primary key itself for peers pinned before subkeys were
 * tracked (or keys that sign with the primary).
 */
export function signingKeysOf(peer: PinnedPeer): { fingerprint: string; algo: string; }[] {
    const primary = normalizeFingerprint(peer.fingerprint);

    if (peer.signingKeys?.length) {
        return peer.signingKeys
            .map(k => ({ fingerprint: normalizeFingerprint(k.fingerprint), algo: k.algo }))
            .filter(k => k.fingerprint);
    }

    // Legacy records carry fingerprints only; the algorithm is known for the
    // primary alone.
    const legacy = (peer.signingFingerprints ?? []).map(normalizeFingerprint).filter(Boolean);
    return (legacy.length ? legacy : [primary])
        .map(fingerprint => ({ fingerprint, algo: fingerprint === primary ? peer.algo : "" }));
}

export function signerFingerprintsOf(peer: PinnedPeer): string[] {
    return signingKeysOf(peer).map(k => k.fingerprint);
}

/**
 * Find the peer that owns a signing key. A signature names the *subkey* that
 * made it, which is not the fingerprint a peer is stored under.
 */
export function getPeerBySigner(fingerprint: string): PinnedPeer | undefined {
    const fpr = normalizeFingerprint(fingerprint);
    return getPeer(fpr) ?? getPeers().find(p => signerFingerprintsOf(p).includes(fpr));
}

export function arePeersLoaded(): boolean {
    return peersLoaded;
}

export async function putPeer(peer: PinnedPeer): Promise<void> {
    const fingerprint = normalizeFingerprint(peer.fingerprint);
    if (fingerprint.length !== 40) throw new Error("dsig: a fingerprint must be 40 hex characters");
    peers = { ...peers, [fingerprint]: { ...peer, fingerprint } };
    await DataStore.set(PEERS_KEY, peers);
    invalidateAll();
    emit();
}

export async function deletePeer(fingerprint: string): Promise<void> {
    const key = normalizeFingerprint(fingerprint);
    const { [key]: _removed, ...rest } = peers;
    peers = rest;
    await DataStore.set(PEERS_KEY, peers);
    invalidateAll();
    emit();
}

/** Peers this Discord account id is allowed to be represented by. */
export function peersForUser(userId: string): PinnedPeer[] {
    return getPeers().filter(p => p.discordUserIds.length === 0 || p.discordUserIds.includes(userId));
}

// ── verify cache ──────────────────────────────────────────────────────────

export function getCached(messageId: string, contentHash: string): VerifyResult | undefined {
    const hit = cache.get(messageId);
    if (!hit) return undefined;
    if (hit.contentHash !== contentHash) {
        cache.delete(messageId);
        return undefined;
    }
    // Refresh LRU position.
    cache.delete(messageId);
    cache.set(messageId, hit);
    return hit;
}

export function putCached(messageId: string, result: VerifyResult): void {
    cache.delete(messageId);
    cache.set(messageId, result);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
    }
    void persistCache();
}

export function invalidate(messageId: string): void {
    cache.delete(messageId);
}

/** Pinning or unpinning a key changes every verdict; drop the lot. */
export function invalidateAll(): void {
    cache.clear();
    void DataStore.del(CACHE_KEY).catch(() => void 0);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistCache(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        const plain: Record<string, VerifyResult> = {};
        for (const [k, v] of cache) plain[k] = v;
        void DataStore.set(CACHE_KEY, plain).catch(() => void 0);
    }, 2000);
}

export async function loadCache(): Promise<void> {
    const stored = (await DataStore.get<Record<string, VerifyResult>>(CACHE_KEY)) ?? {};
    for (const [k, v] of Object.entries(stored)) cache.set(k, v);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
    }
}
