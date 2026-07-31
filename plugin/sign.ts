/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — the signing path (pre-send / pre-edit).
 */

import { ChannelStore } from "@webpack/common";

import { getBackend, logger } from "./crypto/backend";
import { encodeFooter } from "./crypto/footer";
import { compress } from "./crypto/packet";
import { buildPayload, canonicalizeContent, type PayloadMode } from "./crypto/payload";
import { settings } from "./settings";
import type { SignMode } from "./types";

const DM_TYPES = new Set([1, 3]); // DM, GROUP_DM

export function shouldSign(channelId: string): boolean {
    if (!settings.store.signOutgoing) return false;
    if (!settings.store.signingKey && settings.store.backend === "gpg") return false;

    switch (settings.store.signChannels) {
        case "dm": {
            const channel = ChannelStore.getChannel(channelId);
            return !!channel && DM_TYPES.has(channel.type);
        }
        case "allowlist":
            return String(settings.store.channelAllowlist ?? "")
                .split(/[\s,]+/)
                .filter(Boolean)
                .includes(channelId);
        default:
            return true;
    }
}

export interface SignedMessage {
    /** Canonical content plus the footer line. */
    content: string;
    signedTsMs: number;
    /** The mode actually used — compact silently degrades when it cannot apply. */
    mode: SignMode;
    footer: string;
}

/**
 * Sign `content` and return it with the footer appended.
 *
 * Compact mode is only used when the signature provably survives
 * compress → inflate byte for byte; otherwise the raw packet travels instead.
 * That keeps a exotic gpg build from producing footers nobody can verify.
 */
export async function signContent(
    mode: PayloadMode,
    authorId: string,
    channelId: string,
    messageId: string | null,
    rawContent: string
): Promise<SignedMessage> {
    const content = canonicalizeContent(rawContent);
    const signedTsMs = Date.now();
    const payload = buildPayload(mode, authorId, channelId, messageId, signedTsMs, content);

    const sig = await getBackend().sign(payload, settings.store.signingKey);

    let blob = sig;
    let used: SignMode = "armored";
    if (settings.store.signMode === "compact") {
        const compact = compress(sig);
        if (compact) {
            blob = compact;
            used = "compact";
        } else {
            logger.warn("signature is not compressible; falling back to the full packet");
        }
    }

    const footer = encodeFooter(signedTsMs, blob);
    return { content: content + "\n" + footer, signedTsMs, mode: used, footer };
}
