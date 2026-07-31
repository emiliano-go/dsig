/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: the verification badge.
 *
 * Cryptographic failure and clock skew are deliberately different colours:
 * users only learn to trust ✗ if it never cries wolf about a slow clock.
 */

import { TooltipContainer } from "@components/TooltipContainer";
import { classNameFactory } from "@utils/css";
import { MessageStore, React, useEffect, useMemo, useState, useStateFromStores } from "@webpack/common";

import { logger } from "../crypto/backend";
import { formatSummary, type GroupableMessage, type GroupSummary, messageGroup, summarize } from "../group";
import { settings } from "../settings";
import { groupFingerprint } from "../store";
import type { VerifyResult, VerifyStatus } from "../types";
import { type VerifiableMessage, verifyMessage } from "../verify";

export const cl = classNameFactory("vc-dsig-");

interface Look {
    label: string;
    /** SVG path drawn inside the shield. Kept as data, not as an element: see below. */
    glyph: string;
}

/*
 * Nothing in this file may evaluate JSX at module scope.
 *
 * Vencord compiles JSX to `VencordCreateElement`, which resolves to
 * `Vencord.Webpack.Common.React.createElement` on first call. That global is
 * assigned by the bundle's own IIFE, so JSX evaluated while the module is
 * still being imported reads `.Webpack` off `undefined`, throws, and takes the
 * *entire* Vencord bundle down with it (Discord then loads unmodded).
 *
 * So LOOKS holds path strings and ShieldIcon builds the element during render.
 */
const LOOKS: Record<Exclude<VerifyStatus, "unsigned">, Look> = {
    valid: { label: "signed", glyph: "m8.6 12 2.4 2.4 4.4-4.6" },
    skew: { label: "signed · time mismatch", glyph: "M12 8.4v4m0 3h.01" },
    invalid: { label: "signature invalid", glyph: "m9.5 9.5 5 5m0-5-5 5" },
    "unknown-signer": { label: "unknown signer", glyph: "M10 10a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.7m0 2.5h.01" },
    pending: { label: "signing…", glyph: "M12 8v4l2.5 1.5" },
    error: { label: "signature error", glyph: "M12 8.4v4m0 3h.01" }
};

function ShieldIcon({ glyph }: { glyph: string; }) {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.9 7.5 10 4.3-1.1 7.5-5.4 7.5-10v-6L12 2.5Z" />
            <path d={glyph} />
        </svg>
    );
}

function labelOf(status: VerifyStatus): string {
    return LOOKS[status as keyof typeof LOOKS]?.label ?? status;
}

/** One line per verdict, so a mixed group says exactly what it is mixed of. */
function GroupTooltip({ summary, results }: { summary: GroupSummary; results: VerifyResult[]; }) {
    const signers = Array.from(new Set(results.map(r => r.peerLabel).filter(Boolean)));
    return (
        <div className={cl("tooltip")}>
            <div>{summary.total} messages in this group</div>
            {summary.parts.map(p => <div key={p.status}>{labelOf(p.status)} × {p.count}</div>)}
            {summary.unsigned > 0 && <div>{summary.unsigned} unsigned</div>}
            {signers.length > 0 && <div>{signers.join(", ")}</div>}
        </div>
    );
}

function Tooltip({ result }: { result: VerifyResult; }) {
    return (
        <div className={cl("tooltip")}>
            <div>{labelOf(result.status)}</div>
            {result.peerLabel && <div>{result.peerLabel}</div>}
            {result.fingerprint && <div className={cl("fpr")}>{groupFingerprint(result.fingerprint)}</div>}
            {result.status === "valid" && (
                <div>author, channel and time are bound into the signature</div>
            )}
            {result.snowflakeDeltaMs != null && result.status !== "valid" && (
                <div>Δt {(result.snowflakeDeltaMs / 1000).toFixed(1)}s</div>
            )}
            {result.detail && <div>{result.detail}</div>}
            {result.signedTsMs != null && (
                <div>signed {new Date(result.signedTsMs).toLocaleString()}</div>
            )}
        </div>
    );
}

function identityOf(message: VerifiableMessage): string {
    return [message.id, String(message.editedTimestamp ?? ""), message.content].join("\u0000");
}

/**
 * Last verdict seen for a given piece of text, keyed without the message id.
 *
 * A message changes id once: the local copy Discord shows while sending is
 * replaced by the server's, which re-opens verification under a new id and,
 * for that moment, has no verdict at all. Blanking the badge there is what
 * made it flash and vanish. The old verdict stands in until the new one lands.
 * It can only be stale about clock skew, since author, channel and text are
 * identical by construction.
 */
const lastVerdict = new Map<string, VerifyResult>();

function contentKey(message: VerifiableMessage): string {
    return [message.channel_id, String(message.editedTimestamp ?? ""), message.content].join("\u0000");
}

function remember(message: VerifiableMessage, result: VerifyResult): VerifyResult {
    if (lastVerdict.size > 300) lastVerdict.clear();
    lastVerdict.set(contentKey(message), result);
    return result;
}

/**
 * Resolve verification results for a whole group. `verifyMessage` answers
 * synchronously from cache when it can, so cached messages render their badge
 * on the first paint with no flash; the rest fill in as they resolve.
 */
export function useVerification(messages: VerifiableMessage[]): (VerifyResult | null)[] {
    const key = messages.map(identityOf).join("\u0001");
    const settle = () => messages.map(m => {
        const res = verifyMessage(m);
        return res instanceof Promise
            ? lastVerdict.get(contentKey(m)) ?? null
            : remember(m, res);
    });

    const [results, setResults] = useState<(VerifyResult | null)[]>(settle);

    useEffect(() => {
        let live = true;
        setResults(settle());

        messages.forEach((message, i) => {
            const res = verifyMessage(message);
            if (!(res instanceof Promise)) return;
            res.then(value => {
                remember(message, value);
                if (!live) return;
                setResults(prev => {
                    if (prev.length !== messages.length) return prev;
                    const next = prev.slice();
                    next[i] = value;
                    return next;
                });
            }, () => void 0);
        });

        return () => { live = false; };
    }, [key]);

    return results;
}

function sameGroup(a: GroupableMessage[], b: GroupableMessage[]): boolean {
    return a.length === b.length && a.every((m, i) => m.id === b[i].id && m.content === b[i].content);
}

/**
 * The messages this badge answers for. Subscribed to MessageStore because a
 * new message joining the group has to widen the count on a header that is
 * already on screen.
 *
 * Anything unexpected falls back to the one message we were handed. This runs
 * inside a `noop` ErrorBoundary, so a throw here does not show an error: it
 * deletes the badge.
 */
function useGroup(message: GroupableMessage, compact: boolean): GroupableMessage[] {
    return useStateFromStores(
        [MessageStore],
        () => {
            // Compact mode gives every message its own username row, so every
            // message renders its own decoration; aggregating would count the
            // tail of the group once per header.
            if (compact || !message.id) return [message];
            try {
                const channel = MessageStore.getMessages(message.channel_id);
                const list: GroupableMessage[] = channel?.toArray?.() ?? [];
                return (list.length ? messageGroup(list, message.id) : null) ?? [message];
            } catch (e) {
                logger.error("could not read the message group", e);
                return [message];
            }
        },
        [message.id, message.channel_id, compact],
        sameGroup
    );
}

export function Badge({ message, compact = false }: { message: GroupableMessage; compact?: boolean; }) {
    const group = useGroup(message, compact);
    const results = useVerification(group);

    // Messages still in flight are left out rather than shown as "signing…":
    // the count settles a beat later instead of flickering through every state.
    const settled = useMemo(() => results.filter(Boolean) as VerifyResult[], [results]);
    const summary = summarize(settled.map(r => r.status));
    if (!summary) return null;

    const look = LOOKS[summary.status as keyof typeof LOOKS];
    if (!look) return null;

    const label = formatSummary(summary, labelOf);
    const iconOnly = settings.store.badgeStyle === "icon";
    const tooltip = summary.total > 1
        ? <GroupTooltip summary={summary} results={settled} />
        : <Tooltip result={settled[0]} />;

    return (
        <TooltipContainer text={tooltip}>
            <span
                className={`${cl("badge")} ${cl(summary.status)} ${iconOnly ? cl("badge--icon") : ""}`}
                aria-label={`dsig: ${label}`}
            >
                <ShieldIcon glyph={look.glyph} />
                {!iconOnly && <span>{label}</span>}
            </span>
        </TooltipContainer>
    );
}
