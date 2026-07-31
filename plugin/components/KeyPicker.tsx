/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: signing key selection.
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { useAwaiter } from "@utils/react";
import { React, Select, useEffect, useState } from "@webpack/common";

import { activeBackend, getBackend, getNative, nativeAvailable } from "../crypto/backend";
import { getStoredPrivateKey, setStoredPrivateKey } from "../crypto/openpgp";
import { settings } from "../settings";
import { groupFingerprint } from "../store";
import type { KeyInfo } from "../types";
import { cl } from "./Badge";

const ADDKEY_HINT = "gpg --quick-add-key <your-key-id> ed25519 sign never";

function keyLabel(key: KeyInfo): string {
    const uid = key.uids[0] ?? "(no user id)";
    const kind = key.isSubkey ? "subkey" : "key";
    return `${uid}: ${key.algo} ${kind} ${key.fingerprint.slice(-16)}`;
}

/** Ed25519 keys can use compact mode; everything else has to stay armored. */
function isEd25519(key: KeyInfo): boolean {
    return key.algoId === 22 || key.algoId === 27 || /ed25519/i.test(key.algo);
}

function GpgKeyPicker() {
    const [keys, error, loading] = useAwaiter(() => getBackend().listSecretKeys(), {
        fallbackValue: [] as KeyInfo[],
        deps: [settings.use(["gpgPath", "backend"]).gpgPath]
    });

    const [probeError, setProbeError] = useState<string | null>(null);
    useEffect(() => {
        const native = getNative();
        if (!native) return;
        native.probe(settings.store.gpgPath).then(r => setProbeError(r.ok ? null : r.error ?? "gpg is not usable"));
    }, [settings.store.gpgPath]);

    const selected = settings.store.signingKey ?? "";
    const selectedFpr = selected.replace(/!$/, "");
    const current = keys.find(k => k.fingerprint === selectedFpr);
    const signable = keys.filter(k => k.canSign);
    const ed25519 = signable.filter(isEd25519);

    if (!nativeAvailable()) {
        return <Paragraph className={cl("error-text")}>
            The gpg backend needs the desktop app. On web, switch the backend below to openpgp.js.
        </Paragraph>;
    }

    return (
        <div className={cl("section")}>
            {probeError && <Paragraph className={cl("error-text")}>gpg is not usable: {probeError}</Paragraph>}
            {loading && <Paragraph className={cl("muted")}>Reading your keyring…</Paragraph>}
            {error != null && <Paragraph className={cl("error-text")}>{String((error as Error)?.message ?? error)}</Paragraph>}

            {!loading && signable.length === 0 && !error && (
                <Paragraph className={cl("error-text")}>
                    No signing-capable secret key found. Create one, then reopen this panel:{"\n"}
                    <span className={cl("mono")}>gpg --quick-gen-key "Your Name &lt;you@example.com&gt;" ed25519 sign never</span>
                </Paragraph>
            )}

            {!loading && signable.length > 0 && ed25519.length === 0 && (
                <Paragraph className={cl("error-text")}>
                    None of your signing keys is Ed25519, so compact mode is unavailable; signatures will
                    be sent in the larger armored form. To add an Ed25519 signing subkey:{"\n"}
                    <span className={cl("mono")}>{ADDKEY_HINT}</span>
                </Paragraph>
            )}

            <Select
                placeholder="Select a signing key"
                options={signable.map(k => ({
                    label: keyLabel(k) + (isEd25519(k) ? "" : " (armored only)"),
                    value: k.fingerprint
                }))}
                isSelected={v => v === selectedFpr}
                serialize={String}
                select={(fpr: string) => {
                    // The trailing "!" pins this exact (sub)key instead of letting
                    // gpg pick whichever subkey it prefers.
                    settings.store.signingKey = fpr + "!";
                }}
                closeOnSelect
            />

            {current && (
                <Paragraph className={cl("mono")}>
                    {groupFingerprint(current.fingerprint)}
                </Paragraph>
            )}
            {selectedFpr && !current && !loading && (
                <Paragraph className={cl("muted")}>
                    Selected key {groupFingerprint(selectedFpr)} is not in the keyring right now.
                </Paragraph>
            )}
        </div>
    );
}

function OpenpgpKeyPicker() {
    const [armored, setArmored] = useState("");
    const [status, setStatus] = useState<{ ok: boolean; text: string; } | null>(null);
    const [acknowledged, setAcknowledged] = useState(false);
    const [stored, setStored] = useState<string | null>(null);

    useEffect(() => { getStoredPrivateKey().then(setStored); }, []);

    async function importKey() {
        try {
            const info = await getBackend().pubkeyInfo(armored);
            await setStoredPrivateKey(armored);
            settings.store.signingKey = info.fingerprint;
            setStored(armored);
            setStatus({ ok: true, text: `Imported ${groupFingerprint(info.fingerprint)}` });
            setArmored("");
        } catch (e) {
            setStatus({ ok: false, text: (e as Error).message });
        }
    }

    return (
        <div className={cl("section")}>
            <Paragraph className={cl("error-text")}>
                The openpgp.js backend keeps your private key in the browser's IndexedDB, where any
                other plugin or a compromised renderer can read it. Prefer the gpg backend on desktop.
            </Paragraph>

            {stored
                ? <Paragraph className={cl("muted")}>A private key is stored ({groupFingerprint(settings.store.signingKey || "")}).</Paragraph>
                : <Paragraph className={cl("muted")}>No private key stored yet.</Paragraph>}

            <label className={cl("row")}>
                <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.currentTarget.checked)} />
                <span>I understand my private key will be stored in-app</span>
            </label>

            <textarea
                className={cl("textarea")}
                placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                value={armored}
                spellCheck={false}
                onChange={e => setArmored(e.currentTarget.value)}
            />

            <div className={cl("row")}>
                <Button disabled={!acknowledged || !armored.trim()} onClick={importKey}>Import private key</Button>
                {stored && (
                    <Button
                        variant="dangerPrimary"
                        onClick={async () => {
                            await setStoredPrivateKey(null);
                            setStored(null);
                            setStatus({ ok: true, text: "Stored key removed" });
                        }}
                    >Remove stored key</Button>
                )}
            </div>

            {status && <Paragraph className={cl(status.ok ? "ok-text" : "error-text")}>{status.text}</Paragraph>}
        </div>
    );
}

export function KeyPicker() {
    // Re-render when the backend setting flips.
    settings.use(["backend", "signingKey"]);
    return activeBackend() === "openpgp" ? <OpenpgpKeyPicker /> : <GpgKeyPicker />;
}
