/*
 * End-to-end tests of the decision logic in verify.ts, driving real gpg
 * signatures through the real footer/packet/store code paths.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { extractFooter, hasFooter } from "../plugin/crypto/footer.ts";
import { canonicalizeContent } from "../plugin/crypto/payload.ts";
import { signContent } from "../plugin/sign.ts";
import { deletePeer, getPeers, loadPeers, putPeer } from "../plugin/store.ts";
import { verifyMessage, type VerifiableMessage } from "../plugin/verify.ts";
import { gpgAvailable, makeKeyring, type TestKeyring } from "./helpers.ts";
import { getBackend } from "./stubs/backend.ts";
import { _reset } from "./stubs/DataStore.ts";
import { resetSettings, settings } from "./stubs/settings.ts";
import { ChannelStore } from "./stubs/webpack-common.ts";

const hasGpg = gpgAvailable();

const AUTHOR = "100000000000000001";
const OTHER_AUTHOR = "200000000000000002";
const CHANNEL = "876543210987654321";

/** A snowflake whose embedded timestamp is `ms`. */
function snowflakeAt(ms: number): string {
    return String((BigInt(ms) - 1420070400000n) << 22n);
}

/** How many footers of any style the message carries. */
function countFooters(content: string): number {
    let n = 0;
    let rest = content;
    while (hasFooter(rest)) {
        const found = extractFooter(rest);
        if (!found) break;
        n++;
        rest = found.body;
    }
    return n;
}

async function resolve(message: VerifiableMessage) {
    return await verifyMessage(message);
}

describe("verify", { skip: hasGpg ? false : "gpg not installed" }, () => {
    let kr: TestKeyring;
    let prevHome: string | undefined;

    before(async () => {
        kr = makeKeyring();
        prevHome = process.env.GNUPGHOME;
        process.env.GNUPGHOME = kr.home;
    });

    after(() => {
        if (prevHome === undefined) delete process.env.GNUPGHOME;
        else process.env.GNUPGHOME = prevHome;
        kr.dispose();
    });

    beforeEach(async () => {
        _reset();
        resetSettings();
        settings.store.signingKey = kr.fpr + "!";
        await loadPeers();
        for (const p of getPeers()) await deletePeer(p.fingerprint);
    });

    async function pinSelf(discordUserIds: string[] = [AUTHOR]) {
        await putPeer({
            fingerprint: kr.fpr,
            algo: "ed25519",
            uids: ["dsig test <test@dsig.local>"],
            label: "me",
            discordUserIds,
            addedAt: Date.now(),
            armoredPubkey: kr.armoredPubkey
        });
    }

    /** Sign `text` and wrap it in a message object the way Discord would. */
    async function sentMessage(text: string, overrides: Partial<VerifiableMessage> = {}) {
        const signed = await signContent("o", AUTHOR, CHANNEL, null, text);
        return {
            id: snowflakeAt(signed.signedTsMs + 40),
            channel_id: CHANNEL,
            author: { id: AUTHOR },
            content: signed.content,
            ...overrides
        } satisfies VerifiableMessage;
    }

    it("says nothing about unsigned messages", async () => {
        const res = await resolve({ id: snowflakeAt(Date.now()), channel_id: CHANNEL, author: { id: AUTHOR }, content: "plain text" });
        assert.equal(res.status, "unsigned");
    });

    it("verifies a signed message from a pinned peer", async () => {
        await pinSelf();
        const res = await resolve(await sentMessage("hello there"));
        assert.equal(res.status, "valid");
        assert.equal(res.fingerprint, kr.fpr);
        assert.equal(res.peerLabel, "me");
        assert.ok(res.snowflakeDeltaMs! < 1000);
    });

    it("fails when the content was changed after signing", async () => {
        await pinSelf();
        const msg = await sentMessage("hello there");
        msg.content = msg.content.replace("hello there", "hello there!!");
        const res = await resolve(msg);
        assert.equal(res.status, "invalid");
    });

    it("fails when the footer is replayed in another channel", async () => {
        await pinSelf();
        const msg = await sentMessage("lifted");
        const res = await resolve({ ...msg, channel_id: "111111111111111111" });
        assert.equal(res.status, "invalid");
    });

    it("does not attribute a key to an account it is not pinned for", async () => {
        await pinSelf([OTHER_AUTHOR]);
        const res = await resolve(await sentMessage("whose key is this"));
        assert.equal(res.status, "unknown-signer");
    });

    it("reports an unknown signer when nothing is pinned", async () => {
        const res = await resolve(await sentMessage("nobody pinned"));
        assert.equal(res.status, "unknown-signer");

        settings.store.verifyUnknownKeys = false;
        const quiet = await resolve({ ...(await sentMessage("nobody pinned")), id: snowflakeAt(Date.now()) });
        assert.equal(quiet.status, "unsigned");
    });

    it("warns, but stays valid, when the signed time drifts", async () => {
        await pinSelf();
        const msg = await sentMessage("slow clock");
        const drifted = { ...msg, id: snowflakeAt(Date.now() + 90_000) };

        const warned = await resolve(drifted);
        assert.equal(warned.status, "skew");
        assert.ok(warned.snowflakeDeltaMs! > 10_000);
        assert.match(warned.detail!, /away from Discord/);

        settings.store.onSkew = "fail";
        const failed = await resolve({ ...drifted, id: snowflakeAt(Date.now() + 91_000) });
        assert.equal(failed.status, "invalid");
    });

    it("respects the tolerance slider", async () => {
        await pinSelf();
        const msg = await sentMessage("within tolerance");
        const drifted = { ...msg, id: snowflakeAt(Date.now() + 25_000) };

        assert.equal((await resolve(drifted)).status, "skew");

        settings.store.clockToleranceSec = 60;
        assert.equal((await resolve({ ...drifted, id: snowflakeAt(Date.now() + 26_000) })).status, "valid");
    });

    it("reports pending instead of failing during the send race", async () => {
        await pinSelf();
        const msg = await sentMessage("just sent");
        const res = verifyMessage({ ...msg, id: undefined });
        assert.ok(!(res instanceof Promise));
        assert.equal((res as any).status, "pending");
    });

    it("binds the message id on edits", async () => {
        await pinSelf();
        const messageId = snowflakeAt(Date.now() - 60_000);
        const signed = await signContent("e", AUTHOR, CHANNEL, messageId, "edited text");
        const edited: VerifiableMessage = {
            id: messageId,
            channel_id: CHANNEL,
            author: { id: AUTHOR },
            content: signed.content,
            editedTimestamp: new Date(signed.signedTsMs).toISOString()
        };

        assert.equal((await resolve(edited)).status, "valid");

        // the same edit signature on a different message must not verify
        const elsewhere = { ...edited, id: snowflakeAt(Date.now() - 30_000) };
        assert.equal((await resolve(elsewhere)).status, "invalid");
    });

    it("fails an edit made from a client that kept the old footer", async () => {
        await pinSelf();
        const msg = await sentMessage("original wording");
        const stale: VerifiableMessage = {
            ...msg,
            content: msg.content.replace("original wording", "new wording"),
            editedTimestamp: new Date().toISOString()
        };
        assert.equal((await resolve(stale)).status, "invalid");
    });

    it("re-signs an edit instead of stacking a second footer", async () => {
        await pinSelf();
        const messageId = snowflakeAt(Date.now() - 60_000);
        const original = await signContent("o", AUTHOR, CHANNEL, null, "first wording");

        // What the edit box hands back: the stored message, footer included.
        const edited = await signContent("e", AUTHOR, CHANNEL, messageId, original.content.replace("first", "second"));

        assert.equal(countFooters(edited.content), 1, "the old footer must not survive");
        assert.ok(edited.content.startsWith("second wording"));
        assert.notEqual(edited.footer, original.footer);

        const res = await resolve({
            id: messageId,
            channel_id: CHANNEL,
            author: { id: AUTHOR },
            content: edited.content,
            editedTimestamp: new Date(edited.signedTsMs).toISOString()
        });
        assert.equal(res.status, "valid");
    });

    for (const style of ["plain", "subtext"] as const) {
        it(`signs and verifies with the ${style} footer style`, async () => {
            settings.store.footerStyle = style;
            await pinSelf();
            const msg = await sentMessage("style does not change the payload");
            assert.equal((await resolve(msg)).status, "valid");
            assert.equal(countFooters(msg.content), 1);
        });
    }

    for (const text of ["ok", "a message long enough to have carried a signature the old way"]) {
        it(`signs and verifies an invisible footer on a ${text.length}-character message`, async () => {
            settings.store.footerStyle = "hidden";
            await pinSelf();

            const msg = await sentMessage(text);
            assert.equal(msg.content.replace(/[\u2800\uFE00-\uFE0F]/g, ""), text, "the visible text is unchanged");
            assert.ok(!msg.content.includes("dsig:1:"), "nothing visible was appended");
            assert.equal((await resolve(msg)).status, "valid");
        });
    }

    it("verifies armored-mode signatures and reads the signer from the packet", async () => {
        settings.store.signMode = "armored";
        await pinSelf();
        const msg = await sentMessage("independently auditable");
        const res = await resolve(msg);
        assert.equal(res.status, "valid");
        assert.equal(res.fingerprint, kr.fpr);
    });

    it("names the unpinned signer of an armored signature", async () => {
        settings.store.signMode = "armored";
        const res = await resolve(await sentMessage("who am I"));
        assert.equal(res.status, "unknown-signer");
        assert.equal(res.fingerprint, kr.fpr);
    });

    it("caches by message id and re-verifies when the content changes", async () => {
        await pinSelf();
        const msg = await sentMessage("cache me");
        assert.equal((await resolve(msg)).status, "valid");

        // second call is answered from cache, synchronously
        const cached = verifyMessage(msg);
        assert.ok(!(cached instanceof Promise));
        assert.equal((cached as any).status, "valid");

        // an edit changes the content hash, so the cached verdict is dropped
        const tampered = { ...msg, content: msg.content.replace("cache me", "cache you") };
        assert.ok(verifyMessage(tampered) instanceof Promise);
        assert.equal((await resolve(tampered)).status, "invalid");
    });

    it("honours the verifyIncoming switch", async () => {
        await pinSelf();
        settings.store.verifyIncoming = false;
        assert.equal((await resolve(await sentMessage("ignored"))).status, "unsigned");
    });

    it("keeps the signed body byte-identical to what was signed", async () => {
        await pinSelf();
        const typed = "  leading and trailing  \n\nwith a blank line  ";
        const signed = await signContent("o", AUTHOR, CHANNEL, null, typed);
        assert.ok(signed.content.startsWith(canonicalizeContent(typed)));
        const res = await resolve({
            id: snowflakeAt(signed.signedTsMs),
            channel_id: CHANNEL,
            author: { id: AUTHOR },
            content: signed.content
        });
        assert.equal(res.status, "valid");
    });
});

/*
 * The recommended real-world setup: a primary key that only certifies, plus an
 * Ed25519 signing subkey. The peer is pinned under the *primary* fingerprint
 * (that is what `gpg --export` produces) while signatures name the *subkey*,
 * so anything that assumes those are the same fingerprint breaks here.
 */
describe("verify with a signing subkey", { skip: hasGpg ? false : "gpg not installed" }, () => {
    let kr: TestKeyring;
    let prevHome: string | undefined;

    before(async () => {
        kr = makeKeyring("subkey user <sub@dsig.local>", "ed25519", { subkey: true });
        prevHome = process.env.GNUPGHOME;
        process.env.GNUPGHOME = kr.home;
    });

    after(() => {
        if (prevHome === undefined) delete process.env.GNUPGHOME;
        else process.env.GNUPGHOME = prevHome;
        kr.dispose();
    });

    beforeEach(async () => {
        _reset();
        resetSettings();
        settings.store.signingKey = kr.signingFpr + "!";
        await loadPeers();
        for (const p of getPeers()) await deletePeer(p.fingerprint);
    });

    async function pinWholeKey(discordUserIds: string[] = [AUTHOR]) {
        const keys = await getBackend().pubkeyKeys(kr.armoredPubkey);
        const primary = keys.find(k => !k.isSubkey)!;
        await putPeer({
            fingerprint: primary.fingerprint,
            signingKeys: keys.filter(k => k.canSign).map(k => ({ fingerprint: k.fingerprint, algo: k.algo })),
            algo: primary.algo,
            uids: primary.uids,
            label: "subkey user",
            discordUserIds,
            addedAt: Date.now(),
            armoredPubkey: kr.armoredPubkey
        });
    }

    async function sentMessage(text: string) {
        const signed = await signContent("o", AUTHOR, CHANNEL, null, text);
        return {
            id: snowflakeAt(signed.signedTsMs + 40),
            channel_id: CHANNEL,
            author: { id: AUTHOR },
            content: signed.content
        } satisfies VerifiableMessage;
    }

    it("the primary and signing fingerprints really do differ", () => {
        assert.notEqual(kr.fpr, kr.signingFpr);
    });

    it("reads the signing subkey out of the exported public key", async () => {
        const keys = await getBackend().pubkeyKeys(kr.armoredPubkey);
        const signers = keys.filter(k => k.canSign).map(k => k.fingerprint);
        assert.ok(signers.includes(kr.signingFpr), "signing subkey should be listed");
        assert.equal(keys.find(k => !k.isSubkey)!.fingerprint, kr.fpr);
    });

    it("exports the whole key when handed a subkey fingerprint", async () => {
        const armored = await getBackend().exportPubkey(kr.signingFpr + "!");
        const info = await getBackend().pubkeyInfo(armored);
        assert.equal(info.fingerprint, kr.fpr, "gpg exports the primary key");
        assert.equal(info.canSign, true);
    });

    it("verifies a compact signature made by the subkey", async () => {
        await pinWholeKey();
        const res = await resolve(await sentMessage("signed by a subkey"));
        assert.equal(res.status, "valid");
        assert.equal(res.fingerprint, kr.signingFpr, "the badge names the key that signed");
        assert.equal(res.peerLabel, "subkey user");
    });

    it("verifies an armored signature made by the subkey", async () => {
        settings.store.signMode = "armored";
        await pinWholeKey();
        const res = await resolve(await sentMessage("armored by a subkey"));
        assert.equal(res.status, "valid");
        assert.equal(res.fingerprint, kr.signingFpr);
    });

    it("verifies against a peer pinned with the older signingFingerprints field", async () => {
        const keys = await getBackend().pubkeyKeys(kr.armoredPubkey);
        const primary = keys.find(k => !k.isSubkey)!;
        await putPeer({
            fingerprint: primary.fingerprint,
            signingFingerprints: keys.filter(k => k.canSign).map(k => k.fingerprint),
            algo: primary.algo,
            uids: primary.uids,
            label: "old record",
            discordUserIds: [AUTHOR],
            addedAt: Date.now(),
            armoredPubkey: kr.armoredPubkey
        });
        const res = await resolve(await sentMessage("pinned the old way"));
        assert.equal(res.status, "valid");
        assert.equal(res.fingerprint, kr.signingFpr);
    });

    it("still rejects tampering", async () => {
        await pinWholeKey();
        const msg = await sentMessage("original");
        msg.content = msg.content.replace("original", "changed");
        assert.equal((await resolve(msg)).status, "invalid");
    });

    it("still honours the account binding", async () => {
        await pinWholeKey([OTHER_AUTHOR]);
        assert.equal((await resolve(await sentMessage("wrong account"))).status, "unknown-signer");
    });

    it("works for peers pinned before subkeys were tracked", async () => {
        // Legacy record: no signingFingerprints at all, primary key signs.
        const legacy = makeKeyring("legacy <legacy@dsig.local>");
        try {
            process.env.GNUPGHOME = legacy.home;
            settings.store.signingKey = legacy.fpr + "!";
            await putPeer({
                fingerprint: legacy.fpr,
                algo: "ed25519",
                uids: [],
                label: "legacy",
                discordUserIds: [AUTHOR],
                addedAt: Date.now(),
                armoredPubkey: legacy.armoredPubkey
            });
            assert.equal((await resolve(await sentMessage("legacy pin"))).status, "valid");
        } finally {
            process.env.GNUPGHOME = kr.home;
            legacy.dispose();
        }
    });
});

describe("shouldSign", () => {
    it("follows the channel policy", async () => {
        const { shouldSign } = await import("../plugin/sign.ts");
        resetSettings();
        settings.store.signingKey = "DEADBEEF!";

        ChannelStore._set({ [CHANNEL]: { id: CHANNEL, type: 0 }, dm: { id: "dm", type: 1 } });

        assert.equal(shouldSign(CHANNEL), true);

        settings.store.signChannels = "dm";
        assert.equal(shouldSign(CHANNEL), false);
        assert.equal(shouldSign("dm"), true);

        settings.store.signChannels = "allowlist";
        assert.equal(shouldSign(CHANNEL), false);
        settings.store.channelAllowlist = `999, ${CHANNEL}`;
        assert.equal(shouldSign(CHANNEL), true);

        settings.store.signChannels = "all";
        settings.store.signOutgoing = false;
        assert.equal(shouldSign(CHANNEL), false);

        settings.store.signOutgoing = true;
        settings.store.signingKey = "";
        assert.equal(shouldSign(CHANNEL), false, "no key selected means nothing to sign with");
    });
});
