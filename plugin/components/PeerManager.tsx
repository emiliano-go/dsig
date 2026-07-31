/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — pinned peer keys.
 *
 * Pinning is manual and out-of-band by design (SSH known_hosts, not a web of
 * trust): the plugin never trusts a key just because it arrived in a message.
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { React, TextInput, useEffect, UserStore, useState } from "@webpack/common";

import { getBackend } from "../crypto/backend";
import { settings } from "../settings";
import { deletePeer, getPeer, getPeers, groupFingerprint, loadPeers, normalizeFingerprint, onPeersChanged, putPeer, signingKeysOf } from "../store";
import type { KeyInfo, PinnedPeer } from "../types";
import { cl } from "./Badge";

/** What we keep per signing key: enough to show *which* key actually signs. */
function signingKeysFrom(keys: KeyInfo[]): { fingerprint: string; algo: string; }[] {
    return keys.filter(k => k.canSign).map(k => ({ fingerprint: k.fingerprint, algo: k.algo }));
}

function usePeers(): PinnedPeer[] {
    const [peers, setPeers] = useState<PinnedPeer[]>(getPeers());
    useEffect(() => {
        const off = onPeersChanged(() => setPeers(getPeers()));
        void loadPeers();
        return off;
    }, []);
    return peers;
}

function PeerRow({ peer }: { peer: PinnedPeer; }) {
    const [label, setLabel] = useState(peer.label);
    const [ids, setIds] = useState(peer.discordUserIds.join(", "));
    const [saved, setSaved] = useState(false);

    async function save() {
        await putPeer({
            ...peer,
            label: label.trim(),
            discordUserIds: ids.split(/[\s,]+/).filter(id => /^\d{15,25}$/.test(id))
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    }

    // The primary key is what a peer is stored under, but a signature names the
    // subkey that made it — so spell out which keys are actually trusted here,
    // otherwise pinning an ed25519 signing subkey looks like it pinned the
    // (usually RSA) primary instead.
    const mine = normalizeFingerprint(String(settings.store.signingKey ?? ""));
    const signers = signingKeysOf(peer).filter(k => k.fingerprint !== normalizeFingerprint(peer.fingerprint));

    return (
        <div className={cl("peer")}>
            <div className={cl("mono")}>{groupFingerprint(peer.fingerprint)}</div>
            <div className={cl("muted")}>{peer.algo} primary · {peer.uids.join(", ") || "no user id"}</div>
            {signers.length > 0 && (
                <div className={cl("muted")}>
                    signs with{" "}
                    {signers.map(k => `${k.algo || "subkey"} ${groupFingerprint(k.fingerprint.slice(-16))}${k.fingerprint === mine ? " (your signing key)" : ""}`).join(", ")}
                </div>
            )}
            <div className={cl("row")}>
                <TextInput value={label} placeholder="Label" onChange={setLabel} />
                <TextInput value={ids} placeholder="Discord user IDs (comma separated)" onChange={setIds} />
                <Button size="small" onClick={save}>{saved ? "Saved" : "Save"}</Button>
                <Button size="small" variant="dangerPrimary" onClick={() => deletePeer(peer.fingerprint)}>
                    Remove
                </Button>
            </div>
            {peer.discordUserIds.length === 0 && (
                <Paragraph className={cl("muted")}>
                    No Discord ID bound: a badge from this key means “a key you pinned”, not
                    “this account's key”. Add the sender's user ID to make that claim.
                </Paragraph>
            )}
        </div>
    );
}

export function PeerManager() {
    const peers = usePeers();
    const [armored, setArmored] = useState("");
    const [label, setLabel] = useState("");
    const [ids, setIds] = useState("");
    const [status, setStatus] = useState<{ ok: boolean; text: string; } | null>(null);
    const [busy, setBusy] = useState(false);

    async function addPeer() {
        setBusy(true);
        setStatus(null);
        try {
            // Reads the key without importing it into any keyring.
            const keys = await getBackend().pubkeyKeys(armored.trim());
            const info = keys.find(k => !k.isSubkey)!;
            await putPeer({
                fingerprint: info.fingerprint,
                signingKeys: signingKeysFrom(keys),
                algo: info.algo,
                uids: info.uids,
                label: label.trim() || info.uids[0] || info.fingerprint.slice(-16),
                discordUserIds: ids.split(/[\s,]+/).filter(id => /^\d{15,25}$/.test(id)),
                addedAt: Date.now(),
                armoredPubkey: armored.trim()
            });
            setStatus({ ok: true, text: `Pinned ${groupFingerprint(info.fingerprint)} — verify this out of band before trusting it.` });
            setArmored("");
            setLabel("");
            setIds("");
        } catch (e) {
            setStatus({ ok: false, text: (e as Error).message });
        } finally {
            setBusy(false);
        }
    }

    /**
     * Pin your own signing key to your own account. Without this your own
     * messages verify against nothing and badge as "unknown signer", which
     * reads like a problem when it isn't.
     */
    async function pinSelf() {
        setBusy(true);
        setStatus(null);
        try {
            const keyFpr = String(settings.store.signingKey ?? "");
            if (!keyFpr) throw new Error("pick a signing key first");

            const me = UserStore.getCurrentUser()?.id;
            if (!me) throw new Error("could not read your Discord user id");

            const armoredPubkey = await getBackend().exportPubkey(keyFpr);
            const keys = await getBackend().pubkeyKeys(armoredPubkey);
            const info = keys.find(k => !k.isSubkey)!;
            const signingKeys = signingKeysFrom(keys);

            // Short key ids can't be compared against full fingerprints, so only
            // a full fingerprint is checked for membership.
            const signing = normalizeFingerprint(keyFpr);
            if (signing.length === 40 && !signingKeys.some(k => k.fingerprint === signing))
                throw new Error(`your selected signing key ${groupFingerprint(signing)} is not part of the exported key — pick it again above`);

            // Keep any label/ids already set for this key rather than clobbering them.
            const existing = getPeer(info.fingerprint);
            const ids = existing?.discordUserIds.includes(me)
                ? existing.discordUserIds
                : [...(existing?.discordUserIds ?? []), me];

            await putPeer({
                fingerprint: info.fingerprint,
                signingKeys,
                algo: info.algo,
                uids: info.uids,
                label: existing?.label || "me",
                discordUserIds: ids,
                addedAt: existing?.addedAt ?? Date.now(),
                armoredPubkey
            });

            // Pinning a bare subkey is not possible: a verifier needs the primary
            // to check the binding signature, so gpg exports the whole key and the
            // peer is stored under the primary's fingerprint. Say so, or it looks
            // like the wrong key was pinned.
            const selected = signingKeys.find(k => k.fingerprint === signing);
            const note = selected && selected.fingerprint !== normalizeFingerprint(info.fingerprint)
                ? `, including your ${selected.algo} signing subkey ${groupFingerprint(selected.fingerprint.slice(-16))}`
                + ` (the primary ${info.algo} key is pinned too — it is what binds the subkey)`
                : "";
            setStatus({ ok: true, text: `Pinned your own key to account ${me}${note}.` });
        } catch (e) {
            setStatus({ ok: false, text: (e as Error).message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={cl("section")}>
            {peers.length === 0
                ? <Paragraph className={cl("muted")}>No pinned peers yet. Incoming signatures cannot be attributed until you pin a key.</Paragraph>
                : peers.map(p => <PeerRow key={p.fingerprint} peer={p} />)}

            <div className={cl("row")}>
                <Button disabled={busy} onClick={pinSelf}>Pin my own key</Button>
                <Paragraph className={cl("muted")}>
                    Exports your signing key's public half and binds it to this account, so your own
                    messages verify instead of showing “unknown signer”.
                </Paragraph>
            </div>

            <textarea
                className={cl("textarea")}
                placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
                value={armored}
                spellCheck={false}
                onChange={e => setArmored(e.currentTarget.value)}
            />
            <div className={cl("row")}>
                <TextInput value={label} placeholder="Label (optional)" onChange={setLabel} />
                <TextInput value={ids} placeholder="Discord user IDs (optional, recommended)" onChange={setIds} />
                <Button disabled={busy || !armored.trim()} onClick={addPeer}>Add peer</Button>
            </div>

            {status && <Paragraph className={cl(status.ok ? "ok-text" : "error-text")}>{status.text}</Paragraph>}
        </div>
    );
}
