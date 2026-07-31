import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachFooter, carriersNeeded, embedHidden, encodeFooter, hiddenReport, stripHidden, extractFooter, fromBase64, hasFooter, stripFooters, stripTrailingFooters, toBase64 } from "../plugin/crypto/footer.ts";

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

    it("attaches each style the way it has to travel", () => {
        assert.equal(attachFooter("body", ts, sample, "plain"), "body\n" + encodeFooter(ts, sample, "plain"));
        assert.equal(attachFooter("body", ts, sample, "subtext"), "body\n" + encodeFooter(ts, sample, "subtext"));
    });

    it("detects and strips all three styles", () => {
        for (const style of ["plain", "subtext"] as const) {
            const raw = attachFooter("text", ts, sample, style);
            assert.equal(hasFooter(raw), true, style);
            assert.equal(stripFooters(raw), "text", style);
        }
    });

    it("ignores invisible characters in ordinary text", () => {
        const vs16 = "waving \u270B\uFE0F";
        assert.equal(extractFooter(vs16), null);
        assert.equal(hasFooter(vs16), false);
    });

});

describe("stripTrailingFooters", () => {
    const ts = 1751289600123;

    it("removes the footer this plugin appended", () => {
        for (const style of ["plain", "subtext"] as const)
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

describe("the hidden footer", () => {
    const ts = 1751289600123;

    it("works for a message of any length, including a very short one", () => {
        for (const text of ["ok", "", "a message long enough to have carried it the old way"]) {
            const wire = embedHidden(text, ts, sample);
            const parsed = extractFooter(wire);
            assert.equal(parsed?.signedTsMs, ts, text);
            assert.deepEqual(Array.from(parsed!.blob), Array.from(sample), text);
            assert.equal(parsed!.body, text, "the text comes back exactly");
        }
    });

    it("never writes into a link, mention or code span", () => {
        const risky = "see https://example.com/a and <@123456789012345678> and `code` too";
        const wire = embedHidden(risky, ts, sample);
        for (const fragment of ["https://example.com/a", "<@123456789012345678>", "`code`"])
            assert.ok(wire.includes(fragment), `${fragment} was written into`);
    });

    it("adds nothing that draws ink", () => {
        const wire = embedHidden("hi there", ts, sample);
        assert.equal(wire.replace(/[\u2800\uFE00-\uFE0F]/g, ""), "hi there");
    });

    it("spends the message's own characters before adding carriers", () => {
        // A carrier costs a cell of width; a character the message already has
        // costs nothing. A long enough message needs no carriers at all.
        const long = "a message with plenty of characters to carry the whole signature by itself, no carriers needed here at all, none";
        assert.equal(carriersNeeded(long, sample.length), 0);
        assert.ok(!embedHidden(long, ts, sample).includes("\u2800"));
        assert.ok(carriersNeeded("hi", sample.length) > 0);
    });

    it("never stacks more marks than Discord keeps", () => {
        // Four per base character. A longer run is truncated by the client and
        // takes the signature with it; that is the bug this format exists for.
        const wire = embedHidden("hi", ts, sample);
        for (const run of wire.match(/[\uFE00-\uFE0F]+/g) ?? [])
            assert.ok(run.length <= 4, `run of ${run.length} marks`);
    });

    it("strips back to the original text", () => {
        assert.equal(stripHidden(embedHidden("hello there", ts, sample)), "hello there");
    });

    it("replaces its own footer instead of stacking a second one", () => {
        const once = embedHidden("hello", ts, sample);
        const twice = embedHidden(once, ts + 1000, sample);
        assert.equal(extractFooter(twice)?.signedTsMs, ts + 1000);
        assert.equal(stripHidden(twice), "hello");
    });

    it("is not confused by a selector the user typed", () => {
        const parsed = extractFooter(embedHidden("wave \u270B\uFE0F", ts, sample));
        assert.deepEqual(Array.from(parsed!.blob), Array.from(sample));
    });

    it("ignores a message that only has stray selectors", () => {
        assert.equal(hasFooter("waving \u270B\uFE0F"), false);
        assert.equal(extractFooter("waving \u270B\uFE0F"), null);
    });
});

describe("hidden carriers", () => {
    const ts = 1751289600123;
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

    it("puts at most four marks in each grapheme cluster", () => {
        // Four is what Discord keeps. A longer run is truncated by the client
        // and takes the signature with it; that is the bug this format exists
        // for, and the cap is per cluster, so Segmenter is the authority.
        for (const text of ["hi", "a longer message that carries most of it on its own characters"]) {
            for (const { segment } of segmenter.segment(embedHidden(text, ts, sample))) {
                const marks = (segment.match(/[\uFE00-\uFE0F]/g) ?? []).length;
                assert.ok(marks <= 4, `cluster carries ${marks} marks`);
            }
        }
    });

    it("says how many bytes were lost when the stream is cut short", () => {
        const wire = embedHidden("hi", ts, sample);
        assert.equal(hiddenReport(wire).reason, "decodes");

        // The failure that used to surface as an unverifiable signature: the
        // header arrives, the tail does not.
        const report = hiddenReport(wire.slice(0, wire.length - 40));
        assert.equal(report.declaredLength, sample.length);
        assert.ok(report.gotLength! < sample.length);
        assert.match(report.reason, /the signature was cut: \d+ of \d+ bytes arrived/);
    });

    it("catches a footer whose bytes were altered rather than lost", () => {
        const wire = embedHidden("hi", ts, sample);
        // Flip one nibble in the middle of the signature.
        const at = Math.floor(wire.length / 2);
        const flipped = wire.slice(0, at) + String.fromCharCode(wire.charCodeAt(at) ^ 1) + wire.slice(at + 1);
        if (flipped !== wire) assert.match(hiddenReport(flipped).reason, /checksum fails|cut/);
    });
});
