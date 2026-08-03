/*
 * Stand-in for dsig.desktop/crypto/backend.ts.
 *
 * By default it forwards to the real native gpg bridge, so tests of verify.ts
 * exercise genuine signatures. `setBackend` lets a test swap in a fake.
 */

import { exportPubkey, importPubkeyInfo, importPubkeyKeys, listSecretKeys, sign, verify } from "../../dsig.desktop/native.ts";
import type { BackendName, KeyInfo, VerifyNativeResult } from "../../dsig.desktop/types.ts";
import { settings } from "./settings.ts";

export interface Backend {
    name: BackendName;
    listSecretKeys(): Promise<KeyInfo[]>;
    sign(payload: string, keyFpr: string): Promise<Uint8Array>;
    verify(payload: string, sig: Uint8Array, pubkeyArmored: string): Promise<VerifyNativeResult>;
    pubkeyInfo(armored: string): Promise<KeyInfo>;
    pubkeyKeys(armored: string): Promise<KeyInfo[]>;
    exportPubkey(keyFpr: string): Promise<string>;
}

const gpg: Backend = {
    name: "gpg",
    listSecretKeys: () => listSecretKeys(null, settings.store.gpgPath),
    sign: async (payload, keyFpr) => Uint8Array.from(await sign(null, settings.store.gpgPath, keyFpr, payload)),
    verify: (payload, sig, pub) => verify(null, settings.store.gpgPath, payload, Array.from(sig), pub),
    pubkeyInfo: armored => importPubkeyInfo(null, settings.store.gpgPath, armored),
    pubkeyKeys: armored => importPubkeyKeys(null, settings.store.gpgPath, armored),
    exportPubkey: keyFpr => exportPubkey(null, settings.store.gpgPath, keyFpr)
};

let current: Backend = gpg;

export function setBackend(backend: Backend | null): void {
    current = backend ?? gpg;
}

export function getBackend(): Backend {
    return current;
}

export function nativeAvailable(): boolean {
    return true;
}

export function getNative(): null {
    return null;
}

export const logger = {
    warn: () => void 0,
    error: () => void 0,
    info: () => void 0,
    debug: () => void 0
};
