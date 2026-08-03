import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachFooter, embedHidden, encodeFooter, hasHiddenRun, hiddenReport, stripHidden, extractFooter, fromBase64, hasFooter, stripFooters, stripTrailingFooters, toBase64 } from "../plugin/crypto/footer.ts";

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

    it("stays under the hidden overhead", () => {
        // 72 blob bytes ride in a framed 82-byte stream; at three bits per
        // symbol that is 219 zero-width characters.
        const wire = embedHidden("x", 1, sample);
        assert.ok(wire.length <= 220, `wire is ${wire.length} chars`);
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
    const long = "a message with plenty of characters in it, easily enough to carry a whole signature invisibly";

    it("hides a signature in a long enough message", () => {
        const wire = embedHidden(long, ts, sample)!;
        const parsed = extractFooter(wire);
        assert.equal(parsed?.signedTsMs, ts);
        assert.deepEqual(Array.from(parsed!.blob), Array.from(sample));
        assert.equal(parsed!.body, long, "the text comes back exactly");
    });

    it("adds nothing but zero-width symbols", () => {
        const wire = embedHidden(long, ts, sample)!;
        assert.notEqual(wire, long);
        assert.equal(wire.replace(/[\u1160\u115F\uFFA0\u2060\u2062\u200B\u200C\u180E]/g, ""), long, "not one visible character was added");
    });

    it("hides a signature in a message of any length", () => {
        // The run is appended and carries all its own data, so even an empty
        // message works: no floor, no fallback, nothing visible for a
        // non-plugin reader.
        for (const text of ["", "t", "test"]) {
            const wire = embedHidden(text, ts, sample)!;
            const parsed = extractFooter(wire);
            assert.equal(parsed?.signedTsMs, ts, JSON.stringify(text));
            assert.deepEqual(Array.from(parsed!.blob), Array.from(sample), JSON.stringify(text));
            assert.equal(parsed!.body, text, "the text comes back exactly");
        }
    });

    it("never writes into a link, mention or code span", () => {
        const risky = long + " see https://example.com/a and <@123456789012345678> and `code` too";
        const wire = embedHidden(risky, ts, sample)!;
        for (const fragment of ["https://example.com/a", "<@123456789012345678>", "`code`"])
            assert.ok(wire.includes(fragment), `${fragment} was written into`);
    });

    it("strips back to the original text", () => {
        assert.equal(stripHidden(embedHidden(long, ts, sample)!), long);
    });

    it("replaces its own footer instead of stacking a second one", () => {
        const once = embedHidden(long, ts, sample)!;
        const twice = embedHidden(once, ts + 1000, sample)!;
        assert.equal(extractFooter(twice)?.signedTsMs, ts + 1000);
        assert.equal(stripHidden(twice), long);
    });

    it("is not confused by a selector the user typed", () => {
        const parsed = extractFooter(embedHidden(long + " \u270B\uFE0F", ts, sample)!);
        assert.deepEqual(Array.from(parsed!.blob), Array.from(sample));
    });

    it("ignores a message that only has stray selectors", () => {
        assert.equal(hasFooter("waving \u270B\uFE0F"), false);
        assert.equal(extractFooter("waving \u270B\uFE0F"), null);
    });

    it("says how many bytes were lost when the stream is cut short", () => {
        const wire = embedHidden(long, ts, sample)!;
        assert.equal(hiddenReport(wire).reason, "decodes");

        // Drop the last 40 symbols, which is what a truncating client does;
        // the text around them is untouched, so slicing the string would not
        // do it.
        let toDrop = 40;
        const cut = [...wire].reverse().filter(ch => {
            if (toDrop > 0 && /[\u1160\u115F\uFFA0\u2060\u2062\u200B\u200C\u180E]/.test(ch)) { toDrop--; return false; }
            return true;
        }).reverse().join("");

        const report = hiddenReport(cut);
        assert.equal(report.declaredLength, sample.length);
        assert.ok(report.gotLength! < sample.length);
        assert.match(report.reason, /the signature was cut: \d+ of \d+ bytes arrived/);
    });

    it("ignores a stray alphabet character in the text", () => {
        assert.equal(hasFooter("a \u1160 b"), false);
        assert.equal(hasHiddenRun("a \u1160 b"), false);
        assert.equal(extractFooter("a \u1160 b"), null);
    });
});

describe("what the client keeps", () => {
    const ts = 1751289600123;
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

    /** Discord's behaviour, as measured: four marks per character, rest dropped.
     *  The v3 wire form carries no marks at all, so nothing in it is droppable. */
    function survive(wire: string): string {
        let out = "";
        for (const { segment } of segmenter.segment(wire)) out += segment[0] + segment.slice(1, 5);
        return out;
    }

    it("survives the cap this client actually applies", () => {
        const text = "a sentence long enough to carry the whole thing on its own characters, comfortably";
        const wire = embedHidden(text, ts, sample)!;

        assert.equal(survive(wire), wire, "nothing in the wire form should be droppable");
        const parsed = extractFooter(survive(wire));
        assert.deepEqual(Array.from(parsed!.blob), Array.from(sample));
        assert.equal(parsed!.body, text);
    });
});
