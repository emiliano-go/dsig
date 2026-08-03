import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { encodeFooter, extractFooter } from "../dsig.desktop/crypto/footer.ts";
import { compress, inflate, isCompact } from "../dsig.desktop/crypto/packet.ts";
import { buildPayload, canonicalizeContent } from "../dsig.desktop/crypto/payload.ts";
import { parseStatus } from "../dsig.desktop/crypto/status.ts";
import { importPubkeyInfo, listSecretKeys, probe, sign, verify } from "../dsig.desktop/native.ts";
import { GPG, gpgAvailable, makeKeyring, withKeyring, type TestKeyring } from "./helpers.ts";

const hasGpg = gpgAvailable();
const AUTHOR = "123456789012345678";
const CHANNEL = "876543210987654321";

describe("parseStatus", () => {
    it("reads a good signature", () => {
        const s = [
            "[GNUPG:] NEWSIG",
            "[GNUPG:] GOODSIG F1C07BAC2F95A2EA dsig test <test@dsig.local>",
            "[GNUPG:] VALIDSIG 85312A8A026563CCCB0482E5F1C07BAC2F95A2EA 2026-07-31 1785510382 0 4 0 22 10 00"
        ].join("\n");
        const r = parseStatus(s);
        assert.equal(r.good, true);
        assert.equal(r.signerFpr, "85312A8A026563CCCB0482E5F1C07BAC2F95A2EA");
    });

    it("reads a bad signature", () => {
        const r = parseStatus("[GNUPG:] BADSIG F1C07BAC2F95A2EA someone");
        assert.equal(r.good, false);
        assert.match(r.reason!, /does not match/);
    });

    it("does not treat an expired or revoked key as good", () => {
        for (const kind of ["EXPKEYSIG", "REVKEYSIG"]) {
            const r = parseStatus(`[GNUPG:] GOODSIG X x\n[GNUPG:] ${kind} X x`);
            assert.equal(r.good, false, kind);
        }
    });

    it("reports a missing public key", () => {
        const r = parseStatus("[GNUPG:] ERRSIG F1C0 22 10 00 1785510382 9 85312A8A026563CCCB0482E5F1C07BAC2F95A2EA");
        assert.equal(r.good, false);
        assert.match(r.reason!, /public key not available/);
    });

    it("ignores non-status noise", () => {
        assert.equal(parseStatus("gpg: Good signature from whoever").good, false);
    });
});

describe("native gpg bridge", { skip: hasGpg ? false : "gpg not installed" }, () => {
    let kr: TestKeyring;
    before(() => { kr = makeKeyring(); });
    after(() => kr.dispose());

    it("finds a working gpg", async () => {
        const r = await probe(null, GPG);
        assert.equal(r.ok, true);
        assert.match(r.version!, /gpg \(GnuPG\)/);
    });

    it("reports a missing binary instead of throwing raw ENOENT", async () => {
        const r = await probe(null, "/nonexistent/gpg-binary");
        assert.equal(r.ok, false);
        assert.ok(r.error);
    });

    it("refuses shell metacharacters in the gpg path", async () => {
        await assert.rejects(() => sign(null, "gpg; rm -rf /", kr.fpr, "x"), /suspicious/);
    });

    it("refuses a signing key that is not a fingerprint", async () => {
        await assert.rejects(() => sign(null, GPG, "--export-secret-keys", "x"), /hex fingerprint/);
    });

    it("lists signing-capable secret keys", async () => {
        const keys = await withKeyring(kr, () => listSecretKeys(null, GPG));
        const mine = keys.filter(k => k.fingerprint === kr.fpr);
        assert.equal(mine.length, 1);
        assert.equal(mine[0].algoId, 22);
        assert.equal(mine[0].algo, "ed25519");
        assert.equal(mine[0].canSign, true);
        assert.deepEqual(mine[0].uids, ["dsig test <test@dsig.local>"]);
    });

    it("signs and verifies a payload", async () => {
        const payload = buildPayload("o", AUTHOR, CHANNEL, null, Date.now(), "hello there");
        const sigBytes = await withKeyring(kr, () => sign(null, GPG, kr.fpr + "!", payload));
        assert.ok(sigBytes.length > 60);

        const good = await verify(null, GPG, payload, sigBytes, kr.armoredPubkey);
        assert.equal(good.good, true);
        assert.equal(good.signerFpr, kr.fpr);
    });

    it("rejects a payload whose content was tampered with", async () => {
        const payload = buildPayload("o", AUTHOR, CHANNEL, null, Date.now(), "hello there");
        const sigBytes = await withKeyring(kr, () => sign(null, GPG, kr.fpr + "!", payload));
        const tampered = buildPayload("o", AUTHOR, CHANNEL, null, Date.now(), "hello there!");
        const res = await verify(null, GPG, tampered, sigBytes, kr.armoredPubkey);
        assert.equal(res.good, false);
    });

    it("rejects a signature lifted into another channel or author", async () => {
        const ts = Date.now();
        const payload = buildPayload("o", AUTHOR, CHANNEL, null, ts, "same words");
        const sigBytes = await withKeyring(kr, () => sign(null, GPG, kr.fpr + "!", payload));

        const otherChannel = buildPayload("o", AUTHOR, "111111111111111111", null, ts, "same words");
        const otherAuthor = buildPayload("o", "222222222222222222", CHANNEL, null, ts, "same words");
        const otherTime = buildPayload("o", AUTHOR, CHANNEL, null, ts + 1, "same words");

        for (const p of [otherChannel, otherAuthor, otherTime]) {
            assert.equal((await verify(null, GPG, p, sigBytes, kr.armoredPubkey)).good, false);
        }
    });

    it("rejects a valid signature from a key that is not the pinned peer", async () => {
        const other = makeKeyring("someone else <else@dsig.local>");
        try {
            const payload = buildPayload("o", AUTHOR, CHANNEL, null, Date.now(), "impersonation");
            const sigBytes = await withKeyring(other, () => sign(null, GPG, other.fpr + "!", payload));
            // checked against the *wrong* pinned key: gpg has no key that matches
            const res = await verify(null, GPG, payload, sigBytes, kr.armoredPubkey);
            assert.equal(res.good, false);
            // ...and against the right one it passes, proving the payload was fine
            assert.equal((await verify(null, GPG, payload, sigBytes, other.armoredPubkey)).good, true);
        } finally {
            other.dispose();
        }
    });

    it("extracts peer key info without importing into the keyring", async () => {
        const info = await importPubkeyInfo(null, GPG, kr.armoredPubkey);
        assert.equal(info.fingerprint, kr.fpr);
        assert.equal(info.algoId, 22);
        assert.deepEqual(info.uids, ["dsig test <test@dsig.local>"]);

        // the real keyring must not have grown a key
        const other = makeKeyring("victim <victim@dsig.local>");
        try {
            await withKeyring(other, async () => {
                await importPubkeyInfo(null, GPG, kr.armoredPubkey);
                const keys = await listSecretKeys(null, GPG);
                assert.equal(keys.some(k => k.fingerprint === kr.fpr), false);
            });
        } finally {
            other.dispose();
        }
    });

    it("rejects garbage passed as a public key", async () => {
        await assert.rejects(() => importPubkeyInfo(null, GPG, "not a key at all"));
    });

    it("survives a full sign → compact → footer → verify round trip", async () => {
        const content = canonicalizeContent("  round trip  \nwith two lines  ");
        const ts = Date.now();
        const payload = buildPayload("o", AUTHOR, CHANNEL, null, ts, content);

        const sigBytes = await withKeyring(kr, () => sign(null, GPG, kr.fpr + "!", payload));
        const compact = compress(Uint8Array.from(sigBytes));
        assert.ok(compact, "gpg output should be compressible");

        const wire = content + "\n" + encodeFooter(ts, compact);
        assert.ok(wire.length - content.length <= 118);

        // …receiver side, from the raw message only
        const parsed = extractFooter(wire)!;
        assert.ok(isCompact(parsed.blob));
        const rebuilt = inflate(parsed.blob, kr.fpr);
        const recomputed = buildPayload("o", AUTHOR, CHANNEL, null, parsed.signedTsMs, canonicalizeContent(parsed.body));

        const res = await verify(null, GPG, recomputed, Array.from(rebuilt), kr.armoredPubkey);
        assert.equal(res.good, true);
        assert.equal(res.signerFpr, kr.fpr);
    });

    it("catches an edit that reuses the old footer", async () => {
        const ts = Date.now();
        const original = "the original text";
        const payload = buildPayload("o", AUTHOR, CHANNEL, null, ts, original);
        const sigBytes = await withKeyring(kr, () => sign(null, GPG, kr.fpr + "!", payload));
        const wire = "edited text\n" + encodeFooter(ts, compress(Uint8Array.from(sigBytes))!);

        const parsed = extractFooter(wire)!;
        const recomputed = buildPayload("o", AUTHOR, CHANNEL, null, parsed.signedTsMs, canonicalizeContent(parsed.body));
        const res = await verify(null, GPG, recomputed, Array.from(inflate(parsed.blob, kr.fpr)), kr.armoredPubkey);
        assert.equal(res.good, false);
    });

    it("binds the message id on edits", async () => {
        const ts = Date.now();
        const messageId = "999999999999999999";
        const payload = buildPayload("e", AUTHOR, CHANNEL, messageId, ts, "edited");
        const sigBytes = await withKeyring(kr, () => sign(null, GPG, kr.fpr + "!", payload));

        assert.equal((await verify(null, GPG, payload, sigBytes, kr.armoredPubkey)).good, true);
        const elsewhere = buildPayload("e", AUTHOR, CHANNEL, "888888888888888888", ts, "edited");
        assert.equal((await verify(null, GPG, elsewhere, sigBytes, kr.armoredPubkey)).good, false);
    });
});
