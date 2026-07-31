/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: openpgp.js backend.
 *
 * Used on web, or on desktop when the user explicitly picks it. Weaker key
 * custody than gpg-agent: the private key lives in IndexedDB, readable by the
 * renderer, which is why KeyPicker gates it behind an explicit acknowledgement.
 *
 * openpgp.js is not bundled with Vencord. It is loaded at runtime from
 * cdn.jsdelivr.net (already on Vencord's CSP allowlist) unless the page
 * already exposes `globalThis.openpgp`.
 */

import * as DataStore from "@api/DataStore";

import type { KeyInfo, VerifyNativeResult } from "../types";

export const OPENPGP_CDN = "https://cdn.jsdelivr.net/npm/openpgp@6.2.2/dist/openpgp.min.js";

const PRIVKEY_KEY = "dsig:openpgpPrivateKey";

let libPromise: Promise<any> | null = null;

/** Load (once) and hand back the openpgp.js module object. */
export function loadOpenpgp(): Promise<any> {
    if ((globalThis as any).openpgp) return Promise.resolve((globalThis as any).openpgp);
    return libPromise ??= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = OPENPGP_CDN;
        script.async = true;
        script.onload = () => {
            const lib = (globalThis as any).openpgp;
            if (lib) resolve(lib);
            else reject(new Error("dsig: openpgp.js loaded but did not register itself"));
        };
        script.onerror = () => {
            libPromise = null;
            reject(new Error("dsig: could not load openpgp.js (blocked by CSP or offline?)"));
        };
        document.head.appendChild(script);
    });
}

// ── stored private key ────────────────────────────────────────────────────

export async function getStoredPrivateKey(): Promise<string | null> {
    return (await DataStore.get<string>(PRIVKEY_KEY)) ?? null;
}

export async function setStoredPrivateKey(armored: string | null): Promise<void> {
    if (armored) await DataStore.set(PRIVKEY_KEY, armored);
    else await DataStore.del(PRIVKEY_KEY);
}

async function readPrivateKey(): Promise<any> {
    const armored = await getStoredPrivateKey();
    if (!armored) throw new Error("dsig: no private key imported for the openpgp.js backend");
    const openpgp = await loadOpenpgp();
    const key = await openpgp.readPrivateKey({ armoredKey: armored });
    return key.isDecrypted() ? key : openpgp.decryptKey({ privateKey: key, passphrase: "" })
        .catch(() => { throw new Error("dsig: the imported key is passphrase-protected; import a decrypted copy"); });
}

// ── KeyInfo mapping ───────────────────────────────────────────────────────

const ALGO_IDS: Record<string, number> = {
    rsaEncryptSign: 1, rsaSign: 3, elgamal: 16, dsa: 17, ecdh: 18, ecdsa: 19,
    eddsaLegacy: 22, ed25519: 27, ed448: 28
};

function keyInfo(key: any, isSubkey = false): KeyInfo {
    const info = key.getAlgorithmInfo?.() ?? {};
    const algoName: string = info.curve ?? info.algorithm ?? "unknown";
    return {
        fingerprint: String(key.getFingerprint()).toUpperCase(),
        algo: info.bits ? `${info.algorithm}${info.bits}` : algoName,
        algoId: ALGO_IDS[info.algorithm] ?? 0,
        uids: (key.users ?? []).map((u: any) => u.userID?.userID).filter(Boolean),
        canSign: true,
        isSubkey,
        created: Math.floor(new Date(key.getCreationTime?.() ?? Date.now()).getTime() / 1000),
        expires: 0
    };
}

// ── backend surface (mirrors native.ts) ───────────────────────────────────

export async function listSecretKeys(): Promise<KeyInfo[]> {
    const armored = await getStoredPrivateKey();
    if (!armored) return [];
    const openpgp = await loadOpenpgp();
    const key = await openpgp.readPrivateKey({ armoredKey: armored });
    const out = [keyInfo(key)];
    for (const sub of key.getSubkeys?.() ?? []) {
        try {
            if (sub.getAlgorithmInfo) out.push(keyInfo(sub, true));
        } catch { /* skip unreadable subkeys */ }
    }
    return out;
}

export async function sign(payload: string): Promise<Uint8Array> {
    const openpgp = await loadOpenpgp();
    const privateKey = await readPrivateKey();
    const message = await openpgp.createMessage({ text: payload });
    const sig = await openpgp.sign({ message, signingKeys: privateKey, detached: true, format: "binary" });
    return new Uint8Array(sig);
}

export async function verify(payload: string, sigBytes: Uint8Array, pubkeyArmored: string): Promise<VerifyNativeResult> {
    try {
        const openpgp = await loadOpenpgp();
        const verificationKeys = await openpgp.readKey({ armoredKey: pubkeyArmored });
        const signature = await openpgp.readSignature({ binarySignature: sigBytes });
        const message = await openpgp.createMessage({ text: payload });
        const result = await openpgp.verify({ message, signature, verificationKeys, expectSigned: false });

        const first = result.signatures[0];
        if (!first) return { good: false, error: "no signature found" };
        try {
            await first.verified;
        } catch (e) {
            return { good: false, signerFpr: verificationKeys.getFingerprint().toUpperCase(), error: (e as Error).message };
        }
        return { good: true, signerFpr: verificationKeys.getFingerprint().toUpperCase() };
    } catch (e) {
        return { good: false, error: (e as Error).message };
    }
}

/** Every key in an armored blob: primary first, then subkeys. */
export async function pubkeyKeys(armored: string): Promise<KeyInfo[]> {
    const openpgp = await loadOpenpgp();
    const key = await openpgp.readKey({ armoredKey: armored });
    const out = [keyInfo(key)];
    for (const sub of key.getSubkeys?.() ?? []) {
        try {
            out.push(keyInfo(sub, true));
        } catch { /* skip unreadable subkeys */ }
    }
    return out;
}

/** Public half of the stored private key, armored. */
export async function exportPubkey(): Promise<string> {
    const armoredPrivate = await getStoredPrivateKey();
    if (!armoredPrivate) throw new Error("dsig: no private key imported for the openpgp.js backend");
    const openpgp = await loadOpenpgp();
    const key = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
    return key.toPublic().armor();
}

export async function pubkeyInfo(armored: string): Promise<KeyInfo> {
    const openpgp = await loadOpenpgp();
    const key = await openpgp.readKey({ armoredKey: armored });
    return keyInfo(key);
}
