/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: backend selection.
 *
 * Both backends expose the same four operations. The gpg backend forwards to
 * the main process (native.ts); the openpgp.js one runs in the renderer.
 */

import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";

import { settings } from "../settings";
import type { BackendName, KeyInfo, VerifyNativeResult } from "../types";
import * as opgp from "./openpgp";

export const logger = new Logger("dsig", "#8b5cf6");

type NativeApi = PluginNative<typeof import("../native")>;

/** null on web / in a renderer without the native helper. */
export function getNative(): NativeApi | null {
    return (window as any).VencordNative?.pluginHelpers?.Dsig ?? null;
}

export function nativeAvailable(): boolean {
    return getNative() != null;
}

/** The backend actually in use, honouring the setting but falling back on web. */
export function activeBackend(): BackendName {
    const wanted = settings.store.backend as BackendName;
    if (wanted === "gpg" && !nativeAvailable()) return "openpgp";
    return wanted ?? "gpg";
}

export interface Backend {
    name: BackendName;
    listSecretKeys(): Promise<KeyInfo[]>;
    sign(payload: string, keyFpr: string): Promise<Uint8Array>;
    verify(payload: string, sig: Uint8Array, pubkeyArmored: string): Promise<VerifyNativeResult>;
    pubkeyInfo(armored: string): Promise<KeyInfo>;
    /** Every key in an armored blob, primary and subkeys. */
    pubkeyKeys(armored: string): Promise<KeyInfo[]>;
    /** Armored public half of one of your own keys. */
    exportPubkey(keyFpr: string): Promise<string>;
}

const gpgBackend: Backend = {
    name: "gpg",
    async listSecretKeys() {
        const native = getNative();
        if (!native) throw new Error("dsig: the gpg backend needs the desktop app (Vesktop or Discord Desktop)");
        return native.listSecretKeys(settings.store.gpgPath);
    },
    async sign(payload, keyFpr) {
        const native = getNative();
        if (!native) throw new Error("dsig: the gpg backend needs the desktop app");
        if (!keyFpr) throw new Error("dsig: no signing key selected");
        return Uint8Array.from(await native.sign(settings.store.gpgPath, keyFpr, payload));
    },
    async verify(payload, sig, pubkeyArmored) {
        const native = getNative();
        if (!native) throw new Error("dsig: the gpg backend needs the desktop app");
        return native.verify(settings.store.gpgPath, payload, Array.from(sig), pubkeyArmored);
    },
    async pubkeyInfo(armored) {
        const native = getNative();
        if (!native) throw new Error("dsig: the gpg backend needs the desktop app");
        return native.importPubkeyInfo(settings.store.gpgPath, armored);
    },
    async pubkeyKeys(armored) {
        const native = getNative();
        if (!native) throw new Error("dsig: the gpg backend needs the desktop app");
        return native.importPubkeyKeys(settings.store.gpgPath, armored);
    },
    async exportPubkey(keyFpr) {
        const native = getNative();
        if (!native) throw new Error("dsig: the gpg backend needs the desktop app");
        return native.exportPubkey(settings.store.gpgPath, keyFpr);
    }
};

const openpgpBackend: Backend = {
    name: "openpgp",
    listSecretKeys: () => opgp.listSecretKeys(),
    sign: payload => opgp.sign(payload),
    verify: (payload, sig, pub) => opgp.verify(payload, sig, pub),
    pubkeyInfo: armored => opgp.pubkeyInfo(armored),
    pubkeyKeys: armored => opgp.pubkeyKeys(armored),
    exportPubkey: () => opgp.exportPubkey()
};

export function getBackend(): Backend {
    return activeBackend() === "openpgp" ? openpgpBackend : gpgBackend;
}
