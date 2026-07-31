import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeFooter, extractFooter, fromBase64, hasFooter, stripFooters, toBase64 } from "../plugin/crypto/footer.ts";

const sample = Uint8Array.from({ length: 72 }, (_, i) => (i * 7 + 3) & 0xff);

describe("base64", () => {
    it("matches Buffer for every length class", () => {
        for (let n = 0; n < 200; n++) {
            const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
            const expected = Buffer.from(bytes).toString("base64");
            assert.equal(toBase64(bytes), expected, `encode mismatch at length ${n}`);
            assert.deepEqual(Array.from(fromBase64(expected)), Array.from(bytes), `decode mismatch at length ${n}`);
        }
    });

    it("rejects garbage", () => {
        assert.throws(() => fromBase64("not base64!!"));
    });
});

describe("footer", () => {
    it("round-trips timestamp and blob", () => {
        const ts = 1751289600123;
        const footer = encodeFooter(ts, sample);
        const parsed = extractFooter("hello world\n" + footer);
        assert.ok(parsed);
        assert.equal(parsed.signedTsMs, ts);
        assert.deepEqual(Array.from(parsed.blob), Array.from(sample));
        assert.equal(parsed.body, "hello world");
    });

    it("stays under the advertised overhead", () => {
        const footer = encodeFooter(Date.now(), sample);
        assert.ok(footer.length <= 118, `footer is ${footer.length} chars`);
    });

    it("preserves multiline bodies exactly", () => {
        const body = "first\n\nthird line  with  spaces";
        const parsed = extractFooter(body + "\n" + encodeFooter(1, sample));
        assert.equal(parsed?.body, body);
    });

    it("ignores messages without a footer", () => {
        assert.equal(extractFooter("just text"), null);
        assert.equal(extractFooter("‖dsig:1:broken"), null);
        assert.equal(extractFooter("‖dsig:1:zz:%%%%"), null);
        assert.equal(hasFooter("just text"), false);
    });

    it("uses the last footer when a body quotes an earlier one", () => {
        const real = encodeFooter(2, sample);
        const quoted = encodeFooter(1, sample);
        const parsed = extractFooter(`someone said\n${quoted}\nand I replied\n${real}`);
        assert.equal(parsed?.signedTsMs, 2);
        // the quoted footer stays part of the signed body
        assert.ok(parsed!.body.includes(quoted));
    });

    it("strips every footer for display", () => {
        const raw = `text\n${encodeFooter(1, sample)}`;
        assert.equal(stripFooters(raw), "text");
    });

    it("only matches a footer on its own line", () => {
        assert.equal(extractFooter("prefix ‖dsig:1:1:AAAA"), null);
    });
});
