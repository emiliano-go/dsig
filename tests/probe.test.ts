/*
 * The capacity probe: does it measure what Discord does to invisible text?
 *
 * There is no live client here, so these drive the analysis with a *simulated*
 * sanitizer whose rules are the ones measured from the real client. If the real
 * client ever changes, the probe UI reports it; these tests only prove the
 * analysis reads a given transformation correctly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasFooter } from "../dsig.desktop/crypto/footer.ts";
import {
    analyzeProbe,
    analyzeProbe2,
    buildProbe,
    buildProbe2,
    CANDIDATES,
    isProbe,
    isProbe2,
    PROBE2_RUN,
    REPEATS
} from "../dsig.desktop/crypto/probe.ts";

const isVs = (ch: string) => {
    const cp = ch.codePointAt(0)!;
    return cp >= 0xfe00 && cp <= 0xfe0f;
};

/**
 * Discord as measured: format characters stripped, variation selectors capped
 * at four per base character and ~90 total, everything else kept.
 */
function simulateDiscord(sent: string, opts: { keptChars: Set<string>; markCap: number; totalMarkCap: number; }): string {
    let out = "";
    let base = "";
    let marksOnBase = 0;
    let totalMarks = 0;

    for (const ch of sent) {
        if (isVs(ch)) {
            if (marksOnBase < opts.markCap && totalMarks < opts.totalMarkCap) {
                out += ch;
                marksOnBase++;
                totalMarks++;
            }
            continue;
        }
        if (!opts.keptChars.has(ch)) continue; // stripped
        out += ch;
        base = ch;
        marksOnBase = 0;
        void base;
    }
    return out;
}

describe("probe round-trip", () => {
    it("recognises its own output", () => {
        assert.equal(isProbe(buildProbe()), true);
        assert.equal(isProbe("hello"), false);
    });

    it("reports full survival when nothing is touched", () => {
        const report = analyzeProbe(buildProbe());
        for (const r of report.results) assert.equal(r.survived, r.sent, r.name);
        assert.equal(report.spreadKept, report.spreadSent);
        assert.ok(report.survivingBases.length > 0);
    });

    it("stays well under Discord's 2000-character limit", () => {
        assert.ok(buildProbe().length < 2000, `probe is ${buildProbe().length} chars`);
    });

    it("is never mistaken for a footer", () => {
        assert.equal(hasFooter(buildProbe()), false);
        assert.match(buildProbe(), /^dsigprobe1/);
    });
});

describe("probe analysis against a simulated client", () => {
    it("matches the measured reality: only selectors survive, capped, no zero-width base", () => {
        // Keep only the visible ASCII scaffolding and the braille control; strip
        // every zero-width candidate; cap selectors at 4 per base and 90 total.
        const kept = new Set<string>();
        for (const ch of buildProbe()) if (ch.codePointAt(0)! < 128) kept.add(ch);
        kept.add("\u2800"); // the control survives, as measured

        const received = simulateDiscord(buildProbe(), { keptChars: kept, markCap: 4, totalMarkCap: 90 });
        const report = analyzeProbe(received);

        assert.equal(report.survivingBases.length, 0, "no zero-width base should survive this client");
        assert.ok(report.spreadKept <= 90);
        assert.match(report.verdict, /cannot travel invisibly|honest minimum/);
    });

    it("declares invisible signatures feasible when zero-width bases survive", () => {
        // A hypothetical friendlier client: keep everything, no caps.
        const kept = new Set<string>();
        for (const ch of buildProbe()) kept.add(ch);
        const received = simulateDiscord(buildProbe(), { keptChars: kept, markCap: 99, totalMarkCap: 9999 });

        const report = analyzeProbe(received);
        assert.ok(report.survivingBases.length >= 2);
        assert.ok(report.bitsPerBaseChar >= 1);
        assert.match(report.verdict, /survive|feasible|invisible chars/);
    });

    it("counts each candidate within its own delimiters", () => {
        // Drop one candidate entirely; the others must still read correctly.
        const victim = CANDIDATES[0].char;
        const received = buildProbe().split(victim).join("");
        const report = analyzeProbe(received);

        assert.equal(report.results[0].survived, 0, "the dropped candidate reads zero");
        assert.equal(report.results[1].survived, REPEATS, "its neighbour is unaffected");
    });
});

describe("the long-run probe", () => {
    const survivors = ["\u1160", "\u115F"];

    it("builds a run of the requested length and recognises it", () => {
        const probe = buildProbe2(survivors);
        assert.equal(isProbe2(probe), true);
        assert.equal(isProbe(probe), false);
        assert.ok(probe.length >= PROBE2_RUN);
    });

    it("confirms feasibility when the whole run survives in order", () => {
        const r = analyzeProbe2(buildProbe2(survivors), survivors);
        assert.equal(r.survived, PROBE2_RUN);
        assert.equal(r.orderPreserved, true);
        assert.match(r.verdict, /feasible/);
    });

    it("reports truncation when a long run is cut", () => {
        const probe = buildProbe2(survivors);
        // Keep only the first 100 survivor characters.
        let kept = 0;
        const cut = [...probe].filter(ch => (survivors.includes(ch) ? kept++ < 100 : true)).join("");
        const r = analyzeProbe2(cut, survivors);
        assert.ok(r.survived < PROBE2_RUN);
        assert.equal(r.orderPreserved, false);
    });

    it("refuses to build without survivors", () => {
        assert.throws(() => buildProbe2([]));
    });
});
