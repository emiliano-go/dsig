/*
 * Grouping and badge aggregation. Pure logic, no client needed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSummary, type GroupableMessage, MAX_GROUP_GAP_MS, messageGroup, summarize } from "../plugin/group.ts";
import type { VerifyStatus } from "../plugin/types.ts";

const AUTHOR = "100000000000000001";
const OTHER = "200000000000000002";
const CHANNEL = "876543210987654321";

function snowflakeAt(ms: number): string {
    return String((BigInt(ms) - 1420070400000n) << 22n);
}

const T0 = 1751289600000;

let seq = 0;
function msg(atMs: number, overrides: Partial<GroupableMessage> = {}): GroupableMessage {
    return {
        id: snowflakeAt(atMs + seq++),
        channel_id: CHANNEL,
        author: { id: AUTHOR },
        content: "hi",
        ...overrides
    };
}

describe("messageGroup", () => {
    it("collects a run from one author", () => {
        const list = [msg(T0), msg(T0 + 1000), msg(T0 + 2000)];
        assert.deepEqual(messageGroup(list, list[0].id!)?.map(m => m.id), list.map(m => m.id));
    });

    it("never returns an empty group", () => {
        // Discord decides who gets a header; a decoration only exists where one
        // was drawn. Returning [] for a message we think is mid-group deleted
        // the badge whenever that guess disagreed with the client.
        const list = [msg(T0), msg(T0 + 1000)];
        assert.deepEqual(messageGroup(list, list[1].id!)?.map(m => m.id), [list[1].id]);
    });

    it("returns null when the message is not in the list", () => {
        assert.equal(messageGroup([msg(T0)], "999"), null);
    });

    it("breaks on a different author", () => {
        const list = [msg(T0), msg(T0 + 1000, { author: { id: OTHER } }), msg(T0 + 2000)];
        assert.equal(messageGroup(list, list[0].id!)!.length, 1);
    });

    it("breaks after seven minutes", () => {
        const list = [msg(T0), msg(T0 + MAX_GROUP_GAP_MS + 1000)];
        assert.equal(messageGroup(list, list[0].id!)!.length, 1);
    });

    it("keeps a message right at the edge of the window", () => {
        const first = msg(T0);
        const second = { ...msg(T0), id: snowflakeAt(T0 + MAX_GROUP_GAP_MS) };
        assert.equal(messageGroup([first, second], first.id!)!.length, 2);
    });

    it("breaks on a reply, which Discord gives its own header", () => {
        const list = [msg(T0), msg(T0 + 1000, { messageReference: { message_id: "1" } })];
        assert.equal(messageGroup(list, list[0].id!)!.length, 1);
    });

    it("breaks on a system message", () => {
        const list = [msg(T0), msg(T0 + 1000, { type: 7 })];
        assert.equal(messageGroup(list, list[0].id!)!.length, 1);
    });

    it("does not group a user message with a webhook post", () => {
        const list = [msg(T0), msg(T0 + 1000, { webhookId: "42" })];
        assert.equal(messageGroup(list, list[0].id!)!.length, 1);
    });

    it("falls back to the timestamp when the id is not a snowflake", () => {
        const pending = { ...msg(T0), id: "nonce-abc", timestamp: new Date(T0 + 1000).toISOString() };
        const list = [msg(T0), pending];
        assert.equal(messageGroup(list, list[0].id!)!.length, 2);
    });
});

describe("summarize", () => {
    const of = (...statuses: VerifyStatus[]) => summarize(statuses);
    const label = (s: VerifyStatus) => ({
        valid: "signed",
        skew: "signed · time mismatch",
        invalid: "signature invalid",
        "unknown-signer": "unknown signer",
        pending: "signing…",
        error: "signature error",
        unsigned: "unsigned"
    })[s];

    it("says nothing when the whole group is unsigned", () => {
        assert.equal(of(), null);
        assert.equal(of("unsigned", "unsigned"), null);
    });

    it("reads like today for a single signed message", () => {
        const s = of("valid")!;
        assert.equal(s.status, "valid");
        assert.equal(formatSummary(s, label), "signed");
    });

    it("counts a collapsed run", () => {
        const s = of(...Array(7).fill("valid") as VerifyStatus[])!;
        assert.equal(s.signed, 7);
        assert.equal(formatSummary(s, label), "signed ×7");
    });

    it("calls out unsigned messages inside a signed run", () => {
        const statuses = [...Array(8).fill("valid"), "unsigned", "unsigned"] as VerifyStatus[];
        const s = summarize(statuses)!;
        assert.equal(s.total, 10);
        assert.equal(s.unsigned, 2);
        assert.equal(formatSummary(s, label), "signed ×8 · 2 unsigned");
    });

    it("takes its badge from the worst verdict, not the commonest", () => {
        const s = of("valid", "valid", "invalid", "valid")!;
        assert.equal(s.status, "invalid");
        assert.equal(formatSummary(s, label), "signature invalid · signed ×3");
    });

    it("orders every verdict by severity", () => {
        const s = of("valid", "skew", "unknown-signer", "invalid")!;
        assert.deepEqual(s.parts.map(p => p.status), ["invalid", "unknown-signer", "skew", "valid"]);
    });
});
