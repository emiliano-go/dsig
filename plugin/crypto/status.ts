/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — GnuPG --status-fd parsing.
 *
 * Verification verdicts come from here, never from gpg's exit code: gpg exits
 * 0 in situations that are not a good signature, and non-zero in situations
 * that are.
 *
 * Dependency-free so the test suite can exercise it directly.
 */

export interface GpgStatus {
    good: boolean;
    /** Fingerprint of the key that made the signature, when gpg reports one. */
    signerFpr?: string;
    /** Human-readable reason when the signature is not good. */
    reason?: string;
}

export function parseStatus(status: string): GpgStatus {
    const lines = status.split("\n").map(l => l.trim()).filter(l => l.startsWith("[GNUPG:] "));
    const out: GpgStatus = { good: false };

    for (const raw of lines) {
        const [kind, ...rest] = raw.slice(9).split(" ");
        switch (kind) {
            case "VALIDSIG":
                out.signerFpr = (rest[0] ?? "").toUpperCase();
                break;
            case "GOODSIG":
                out.good = true;
                break;
            case "EXPKEYSIG":
            case "REVKEYSIG":
                // The maths checks out, but the key must not be trusted.
                out.good = false;
                out.reason = kind === "EXPKEYSIG" ? "signing key is expired" : "signing key is revoked";
                break;
            case "BADSIG":
                out.good = false;
                out.reason = "signature does not match the content";
                break;
            case "ERRSIG":
                out.good = false;
                out.reason = rest[5] === "9" ? "public key not available" : "signature could not be checked";
                if (!out.signerFpr && /^[0-9A-F]{40}$/i.test(rest[6] ?? "")) out.signerFpr = rest[6].toUpperCase();
                break;
            case "EXPSIG":
                out.good = false;
                out.reason = "signature is expired";
                break;
        }
    }

    return out;
}
