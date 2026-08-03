/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: message groups.
 *
 * Discord collapses consecutive messages from the same author under a single
 * header, and a message decoration only renders on that header. Without this
 * module the badge would silently describe the first message of a run of ten
 * and say nothing about the other nine.
 *
 * So the head of a group answers for the whole group: the messages it covers
 * are reconstructed here, verified individually, and reported as one summary.
 * The grouping rules mirror Discord's; when they drift the badge under-reports
 * (a shorter group, more headers), which is the safe direction.
 *
 * Dependency-free apart from the payload helpers: this is all pure logic so it
 * can be tested without a client.
 */

import { snowflakeToMs } from "./crypto/payload";
import type { VerifyStatus } from "./types";
import type { VerifiableMessage } from "./verify";

/** Discord starts a new header after seven minutes of silence. */
export const MAX_GROUP_GAP_MS = 7 * 60 * 1000;

/** DEFAULT and REPLY are the only user-authored types; a REPLY never groups. */
const TYPE_DEFAULT = 0;

export interface GroupableMessage extends VerifiableMessage {
    id?: string;
    type?: number;
    timestamp?: { toString(): string; } | string | null;
    messageReference?: unknown;
    webhookId?: string | null;
    blocked?: boolean;
}

function timeOf(message: GroupableMessage): number | null {
    if (message.id && /^\d{17,20}$/.test(message.id)) return snowflakeToMs(message.id);
    const parsed = message.timestamp == null ? NaN : Date.parse(String(message.timestamp));
    return Number.isFinite(parsed) ? parsed : null;
}

/** A message that can sit inside a group at all (not a system event or reply). */
function isPlain(message: GroupableMessage): boolean {
    return (message.type ?? TYPE_DEFAULT) === TYPE_DEFAULT
        && message.messageReference == null
        && message.blocked !== true;
}

/** Would Discord draw `next` under `prev` with no header of its own? */
export function groupsWith(prev: GroupableMessage, next: GroupableMessage): boolean {
    if (!isPlain(prev) || !isPlain(next)) return false;
    if (!prev.author?.id || prev.author.id !== next.author?.id) return false;
    if ((prev.webhookId ?? null) !== (next.webhookId ?? null)) return false;

    const a = timeOf(prev);
    const b = timeOf(next);
    if (a == null || b == null) return false;
    return b - a >= 0 && b - a <= MAX_GROUP_GAP_MS;
}

/**
 * The messages rendered under `headId`'s header, `null` when the id is not in
 * `messages` (the caller should fall back to the single message it has).
 *
 * Head-ness is never decided here. A decoration is only mounted where Discord
 * drew a header, so a call to this function *is* the client saying "this one
 * has a header" - and it is right where our rules would be guessing. Deciding
 * that ourselves cost a badge every time the two disagreed: the message got an
 * empty group and rendered nothing.
 */
export function messageGroup(messages: GroupableMessage[], headId: string): GroupableMessage[] | null {
    const at = messages.findIndex(m => m.id === headId);
    if (at < 0) return null;

    const group = [messages[at]];
    for (let i = at + 1; i < messages.length; i++) {
        if (!groupsWith(messages[i - 1], messages[i])) break;
        group.push(messages[i]);
    }
    return group;
}

// ── summarising a group ───────────────────────────────────────────────────

/** Worst first: the badge takes its colour and glyph from the head of this. */
const SEVERITY: VerifyStatus[] = ["invalid", "unknown-signer", "error", "skew", "pending", "valid"];

export interface GroupSummary {
    /** The most serious status present; drives the badge's look. */
    status: VerifyStatus;
    /** Messages in the group, signed or not. */
    total: number;
    /** Messages carrying a signature of any verdict. */
    signed: number;
    unsigned: number;
    /** Counts per status, worst first, excluding "unsigned". */
    parts: { status: VerifyStatus; count: number; }[];
}

/**
 * Fold a group's verdicts into one badge. Returns null when there is nothing
 * to say: an all-unsigned group must not grow a badge it never had.
 */
export function summarize(statuses: VerifyStatus[]): GroupSummary | null {
    const parts = SEVERITY
        .map(status => ({ status, count: statuses.filter(s => s === status).length }))
        .filter(p => p.count > 0);

    if (parts.length === 0) return null;

    const signed = parts.reduce((n, p) => n + p.count, 0);
    return {
        status: parts[0].status,
        total: statuses.length,
        signed,
        unsigned: statuses.length - signed,
        parts
    };
}

/**
 * "signed", "signed ×7", "signed ×8 · 2 unsigned", "signature invalid · signed ×5".
 * `labelOf` supplies the wording so this stays independent of the badge's copy.
 */
export function formatSummary(summary: GroupSummary, labelOf: (status: VerifyStatus) => string): string {
    const parts = summary.parts.map(p => (p.count > 1 ? `${labelOf(p.status)} ×${p.count}` : labelOf(p.status)));
    if (summary.unsigned > 0) parts.push(`${summary.unsigned} unsigned`);
    return parts.join(" · ");
}
