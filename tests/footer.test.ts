import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachFooter, encodeFooter, extractFooter, fromBase64, hasFooter, stripFooters, stripTrailingFooters, toBase64 } from "../plugin/crypto/footer.ts";

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

describe("footer styles", () => {
    const ts = 1751289600123;

    it("round-trips the subtext form", () => {
        const footer = encodeFooter(ts, sample, "subtext");
        assert.ok(footer.startsWith("-# ‖dsig:1:"));
        const parsed = extractFooter("hello\n" + footer);
        assert.equal(parsed?.signedTsMs, ts);
        assert.deepEqual(Array.from(parsed!.blob), Array.from(sample));
        assert.equal(parsed!.body, "hello");
    });

    it("round-trips the hidden form", () => {
        const footer = encodeFooter(ts, sample, "hidden");
        const parsed = extractFooter("hello" + footer);
        assert.equal(parsed?.signedTsMs, ts);
        assert.deepEqual(Array.from(parsed!.blob), Array.from(sample));
        assert.equal(parsed!.body, "hello");
    });

    it("hides every byte value behind an invisible codepoint", () => {
        const all = Uint8Array.from({ length: 256 }, (_, i) => i);
        const footer = encodeFooter(ts, all, "hidden");
        assert.deepEqual(Array.from(extractFooter("x" + footer)!.blob), Array.from(all));
        // Nothing in the run draws anything.
        for (const ch of footer) {
            const cp = ch.codePointAt(0)!;
            const invisible = cp === 0x2062 || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
            assert.ok(invisible, `footer draws U+${cp.toString(16).toUpperCase()}`);
        }
    });

    it("attaches each style the way it has to travel", () => {
        assert.equal(attachFooter("body", ts, sample, "plain"), "body\n" + encodeFooter(ts, sample, "plain"));
        assert.equal(attachFooter("body", ts, sample, "subtext"), "body\n" + encodeFooter(ts, sample, "subtext"));
        // No newline: a blank last line would be visible to everyone.
        assert.equal(attachFooter("body", ts, sample, "hidden"), "body" + encodeFooter(ts, sample, "hidden"));
    });

    it("detects and strips all three styles", () => {
        for (const style of ["plain", "subtext", "hidden"] as const) {
            const raw = attachFooter("text", ts, sample, style);
            assert.equal(hasFooter(raw), true, style);
            assert.equal(stripFooters(raw), "text", style);
        }
    });

    it("ignores a hidden run that is not a dsig footer", () => {
        // A lone variation selector (an emoji presentation request, say).
        const vs16 = "waving \u270B\uFE0F";
        assert.equal(extractFooter(vs16), null);
        assert.equal(hasFooter(vs16), false);
    });

    it("takes the later footer when both forms are present", () => {
        const quoted = encodeFooter(1, sample, "plain");
        const real = encodeFooter(2, sample, "hidden");
        assert.equal(extractFooter(`quoting\n${quoted}\nmy reply${real}`)?.signedTsMs, 2);
        assert.equal(extractFooter(`quoting${real}\nmy reply\n${quoted}`)?.signedTsMs, 1);
    });
});

describe("stripTrailingFooters", () => {
    const ts = 1751289600123;

    it("removes the footer this plugin appended", () => {
        for (const style of ["plain", "subtext", "hidden"] as const)
            assert.equal(stripTrailingFooters(attachFooter("my text", ts, sample, style)), "my text", style);
    });

    it("removes a stack of them, which is what a re-edit produces", () => {
        const doubled = attachFooter(attachFooter("my text", 1, sample, "plain"), 2, sample, "subtext");
        assert.equal(stripTrailingFooters(doubled), "my text");
    });

    it("leaves a quoted footer where the user put it", () => {
        const quoted = `they said\n${encodeFooter(1, sample)}\nand I disagree`;
        assert.equal(stripTrailingFooters(quoted), quoted);
        assert.equal(stripTrailingFooters(attachFooter(quoted, 2, sample, "plain")), quoted);
    });

    it("is a no-op on unsigned text", () => {
        assert.equal(stripTrailingFooters("nothing to see"), "nothing to see");
    });
});
