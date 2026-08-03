import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPayload, canonicalizeContent, contentHash, snowflakeToMs } from "../dsig.desktop/crypto/payload.ts";

describe("canonicalizeContent", () => {
    it("is idempotent", () => {
        const samples = [
            "hello",
            "  padded  ",
            "line one   \nline two\t\n\n",
            "\r\nwindows\r\nnewlines\r\n",
            "café", // decomposed forms below
            "café",
            "",
            "\n\n\n",
            "emoji 🐈 and ‖ pipes"
        ];
        for (const s of samples) {
            const once = canonicalizeContent(s);
            assert.equal(canonicalizeContent(once), once, `not idempotent: ${JSON.stringify(s)}`);
        }
    });

    it("normalises to NFC", () => {
        assert.equal(canonicalizeContent("café"), canonicalizeContent("café"));
        assert.equal(canonicalizeContent("café").length, 4);
    });

    it("normalises newlines and trailing whitespace", () => {
        assert.equal(canonicalizeContent("a\r\nb"), "a\nb");
        assert.equal(canonicalizeContent("a   \nb  "), "a\nb");
        assert.equal(canonicalizeContent("   spaced   "), "spaced");
    });

    it("keeps interior blank lines", () => {
        assert.equal(canonicalizeContent("a\n\nb"), "a\n\nb");
    });

    it("is a fixed point of Discord's own trim", () => {
        // Whatever Discord does on top (it trims the message), our canonical
        // form must survive unchanged or every signature would break.
        const trimLikeDiscord = (s: string) => s.trim();
        for (const s of ["hi", " hi ", "a\nb\n", "\n\nx"]) {
            const c = canonicalizeContent(s);
            assert.equal(trimLikeDiscord(c), c);
        }
    });
});

describe("buildPayload", () => {
    const author = "123456789012345678";
    const channel = "876543210987654321";
    const msg = "111111111111111111";

    it("builds the original-send form", () => {
        assert.equal(
            buildPayload("o", author, channel, null, 1700000000000, "hello"),
            `dsig-v1\no\n${author}\n${channel}\n1700000000000\nhello`
        );
    });

    it("builds the edit form with the message id bound", () => {
        assert.equal(
            buildPayload("e", author, channel, msg, 1700000000000, "hello"),
            `dsig-v1\ne\n${author}\n${channel}\n${msg}\n1700000000000\nhello`
        );
    });

    it("puts content last so multiline content cannot shift fields", () => {
        const sneaky = "x\n999999999999999999\nnope";
        const p = buildPayload("o", author, channel, null, 1, sneaky);
        assert.ok(p.endsWith("\n" + sneaky));
        // 5 header lines (version, mode, author, channel, ts) + the content lines
        assert.equal(p.split("\n").length, 5 + sneaky.split("\n").length);
    });

    it("rejects non-snowflake ids and bad timestamps", () => {
        assert.throws(() => buildPayload("o", "not-an-id", channel, null, 1, "x"));
        assert.throws(() => buildPayload("o", author, "12\n34", null, 1, "x"));
        assert.throws(() => buildPayload("o", author, channel, null, 0, "x"));
        assert.throws(() => buildPayload("e", author, channel, null, 1, "x"));
    });

    it("distinguishes original and edit payloads for identical content", () => {
        const a = buildPayload("o", author, channel, null, 1700000000000, "hi");
        const b = buildPayload("e", author, channel, msg, 1700000000000, "hi");
        assert.notEqual(a, b);
    });
});

describe("snowflakeToMs", () => {
    it("decodes a known snowflake", () => {
        // Discord epoch itself.
        assert.equal(snowflakeToMs("0"), 1420070400000);
        // 1 second after the epoch: 1000ms << 22
        assert.equal(snowflakeToMs(String(1000n << 22n)), 1420070401000);
    });

    it("round-trips a plausible modern id", () => {
        const ms = 1735689600000; // 2025-01-01
        const id = String((BigInt(ms) - 1420070400000n) << 22n);
        assert.equal(snowflakeToMs(id), ms);
    });
});

describe("contentHash", () => {
    it("is stable and differs on change", () => {
        assert.equal(contentHash("abc"), contentHash("abc"));
        assert.notEqual(contentHash("abc"), contentHash("abd"));
        assert.match(contentHash(""), /^[0-9a-f]{16}$/);
    });
});
