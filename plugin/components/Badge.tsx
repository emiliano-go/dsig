/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — the verification badge.
 *
 * Cryptographic failure and clock skew are deliberately different colours:
 * users only learn to trust ✗ if it never cries wolf about a slow clock.
 */

import { TooltipContainer } from "@components/TooltipContainer";
import { classNameFactory } from "@utils/css";
import { React, useEffect, useState } from "@webpack/common";

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

function Tooltip({ result }: { result: VerifyResult; }) {
    return (
        <div className={cl("tooltip")}>
            <div>{LOOKS[result.status as keyof typeof LOOKS]?.label}</div>
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

/**
 * Resolve a verification result for a message. `verifyMessage` answers
 * synchronously from cache when it can, so a cached message renders its badge
 * on the first paint with no flash.
 */
export function useVerification(message: VerifiableMessage): VerifyResult | null {
    const sync = verifyMessage(message);
    const initial = sync instanceof Promise ? null : sync;
    const [result, setResult] = useState<VerifyResult | null>(initial);

    useEffect(() => {
        let live = true;
        const res = verifyMessage(message);
        if (res instanceof Promise) res.then(r => { if (live) setResult(r); }, () => void 0);
        else setResult(res);
        return () => { live = false; };
    }, [message.id, message.content, String(message.editedTimestamp ?? "")]);

    return result;
}

export function Badge({ message }: { message: VerifiableMessage; }) {
    const result = useVerification(message);
    if (!result || result.status === "unsigned") return null;

    const look = LOOKS[result.status as keyof typeof LOOKS];
    if (!look) return null;

    const iconOnly = settings.store.badgeStyle === "icon";

    return (
        <TooltipContainer text={<Tooltip result={result} />}>
            <span
                className={`${cl("badge")} ${cl(result.status)} ${iconOnly ? cl("badge--icon") : ""}`}
                aria-label={`dsig: ${look.label}`}
            >
                <ShieldIcon glyph={look.glyph} />
                {!iconOnly && <span>{look.label}</span>}
            </span>
        </TooltipContainer>
    );
}
