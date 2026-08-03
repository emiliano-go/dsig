import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { fromBase64, toBase64 } from "../dsig.desktop/crypto/footer.ts";
import {
    armor, compress, dearmor, hex, inflate, isCompact, isRawPacket,
    parseSignature, roundTrips, serializeSignature, signatureCreated, signerFingerprint, unhex
} from "../dsig.desktop/crypto/packet.ts";
import { GPG, gpgAvailable, makeKeyring, type TestKeyring } from "./helpers.ts";

const hasGpg = gpgAvailable();

describe("packet framing", () => {
    it("round-trips old-format headers of every length class", () => {
        for (const len of [10, 117, 255, 256, 4000]) {
            const body = Uint8Array.from({ length: len }, (_, i) => i & 0xff);
            body[0] = 4;
            const sig = {
                version: 4, sigType: 0, pubAlgo: 22, hashAlgo: 10,
                hashed: [{ type: 2, data: Uint8Array.of(1, 2, 3, 4) }],
                unhashed: [], digestPrefix: Uint8Array.of(0x98, 0x28),
                mpis: [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)]
            };
            const bytes = serializeSignature(sig);
            assert.ok(isRawPacket(bytes));
            const parsed = parseSignature(bytes);
            assert.equal(parsed.hashAlgo, 10);
            assert.deepEqual(Array.from(parsed.mpis[0]), [1, 2, 3]);
        }
    });

    it("rejects things that are not signature packets", () => {
        assert.equal(isRawPacket(Uint8Array.of(0x01, 0x02)), false);
        assert.throws(() => parseSignature(Uint8Array.of(0x99, 0x00, 0x01, 0x04)));
    });

    it("encodes long subpacket lengths", () => {
        const big = new Uint8Array(300).fill(7);
        const bytes = serializeSignature({
            version: 4, sigType: 0, pubAlgo: 22, hashAlgo: 8,
            hashed: [{ type: 20, data: big }], unhashed: [],
            digestPrefix: Uint8Array.of(1, 2), mpis: [Uint8Array.of(9)]
        });
        const parsed = parseSignature(bytes);
        assert.equal(parsed.hashed[0].data.length, 300);
    });
});

describe("hex helpers", () => {
    it("round-trips", () => {
        const b = Uint8Array.from([0, 1, 15, 16, 255]);
        assert.equal(hex(b), "00010F10FF");
        assert.deepEqual(Array.from(unhex(hex(b))), Array.from(b));
        assert.deepEqual(Array.from(unhex("85 31 2A")), [0x85, 0x31, 0x2a]);
    });
});

describe("compact codec (real gpg signatures)", { skip: hasGpg ? false : "gpg not installed" }, () => {
    let kr: TestKeyring;
    let sig: Uint8Array;

    const gpgSign = (text: string, extra: string[] = []): Uint8Array => {
        const out = execFileSync(GPG, [
            "--batch", "--no-tty", "--yes", "--detach-sign",
            "--local-user", kr.fpr + "!", "--output", "-", ...extra
        ], { env: { ...process.env, GNUPGHOME: kr.home }, input: text, maxBuffer: 1 << 20 });
        return new Uint8Array(out);
    };

    before(() => { kr = makeKeyring(); sig = gpgSign("dsig-v1\no\n1\n2\n3\nhello"); });
    after(() => kr.dispose());

    it("parses what gpg produced", () => {
        const parsed = parseSignature(sig);
        assert.equal(parsed.version, 4);
        assert.equal(parsed.sigType, 0);
        assert.equal(parsed.pubAlgo, 22, "test key should be EdDSA");
        assert.equal(parsed.mpis.length, 2);
        assert.equal(signerFingerprint(sig), kr.fpr);
    });

    it("serialises back byte for byte", () => {
        assert.deepEqual(Array.from(serializeSignature(parseSignature(sig))), Array.from(sig));
    });

    it("compresses to 72 bytes and inflates back byte for byte", () => {
        const compact = compress(sig);
        assert.ok(compact, "gpg signature should be compressible");
        assert.equal(compact.length, 72);
        assert.ok(isCompact(compact));
        assert.deepEqual(Array.from(inflate(compact, kr.fpr)), Array.from(sig));
    });

    it("keeps the footer near the advertised size", () => {
        assert.equal(toBase64(compress(sig)!).length, 96);
    });

    it("preserves the signature creation time", () => {
        const compact = compress(sig)!;
        assert.equal(signatureCreated(compact), signatureCreated(sig));
        assert.ok(Math.abs(signatureCreated(compact)! * 1000 - Date.now()) < 60_000);
    });

    it("works across digest algorithms", () => {
        for (const digest of ["SHA256", "SHA384", "SHA512"]) {
            const s = gpgSign("payload", ["--digest-algo", digest]);
            const c = compress(s);
            assert.ok(c, `${digest} signature should compress`);
            assert.deepEqual(Array.from(inflate(c, kr.fpr)), Array.from(s), digest);
        }
    });

    it("refuses to compress signatures it cannot rebuild", () => {
        const parsed = parseSignature(sig);
        parsed.hashed.push({ type: 20, data: Uint8Array.of(1, 2, 3) });
        assert.equal(compress(serializeSignature(parsed)), null);
        assert.equal(roundTrips(serializeSignature(parsed)), false);
    });

    it("refuses to compress non-EdDSA signatures", () => {
        const rsa = makeKeyring("dsig rsa <rsa@dsig.local>", "rsa2048");
        try {
            const out = execFileSync(GPG, [
                "--batch", "--no-tty", "--yes", "--detach-sign",
                "--local-user", rsa.fpr + "!", "--output", "-"
            ], { env: { ...process.env, GNUPGHOME: rsa.home }, input: "x", maxBuffer: 1 << 20 });
            assert.equal(compress(new Uint8Array(out)), null);
        } finally {
            rsa.dispose();
        }
    });

    it("produces armor gpg itself accepts", () => {
        const armored = armor(sig, toBase64);
        assert.match(armored, /^-----BEGIN PGP SIGNATURE-----/);
        assert.deepEqual(Array.from(dearmor(armored, fromBase64)), Array.from(sig));
        // gpg must be able to check the armored form we emit
        const sigFile = join(kr.home, "roundtrip.asc");
        const msgFile = join(kr.home, "roundtrip.txt");
        writeFileSync(sigFile, armored);
        writeFileSync(msgFile, "dsig-v1\no\n1\n2\n3\nhello");
        execFileSync(GPG, ["--batch", "--no-tty", "--verify", sigFile, msgFile], {
            env: { ...process.env, GNUPGHOME: kr.home },
            stdio: "ignore"
        });
    });
});
