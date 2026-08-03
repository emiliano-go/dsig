/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: the signing path (pre-send / pre-edit).
 */

import { ChannelStore } from "@webpack/common";

import { getBackend, logger } from "./crypto/backend";
import { attachFooter, embedHidden, encodeFooter, stripTrailingFooters } from "./crypto/footer";
import { compress } from "./crypto/packet";
import { buildPayload, canonicalizeContent, type PayloadMode } from "./crypto/payload";
import { settings } from "./settings";
import type { FooterStyle, SignMode } from "./types";

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
    /** The mode actually used; compact silently degrades when it cannot apply. */
    mode: SignMode;
    footer: string;
}

/**
 * Sign `content` and return it with the footer appended.
 *
 * Compact mode is only used when the signature provably survives
 * compress → inflate byte for byte; otherwise the raw packet travels instead.
 * That keeps a exotic gpg build from producing footers nobody can verify.
 *
 * A footer already at the end of `rawContent` is dropped first. That is what
 * makes editing work: the edit box is filled with the stored message, footer
 * and all, so without this an edit would stack a second footer under a stale
 * one and the signature would cover the old footer as if it were prose. A
 * footer quoted mid-message is left alone: the user typed that.
 */
export async function signContent(
    mode: PayloadMode,
    authorId: string,
    channelId: string,
    messageId: string | null,
    rawContent: string
): Promise<SignedMessage> {
    const content = canonicalizeContent(stripTrailingFooters(rawContent));
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

    const style = (settings.store.footerStyle ?? "subtext") as FooterStyle;

    if (style === "hidden") {
        const embedded = embedHidden(content, signedTsMs, blob);
        // The appended run eats into Discord's 2000-character message limit;
        // past it the run would be truncated and the message arrive unsigned.
        if (embedded.length > 2000)
            throw new Error(`message too long for an invisible footer (the run needs ${embedded.length - content.length} characters)`);
        return { content: embedded, signedTsMs, mode: used, footer: "" };
    }

    const footer = encodeFooter(signedTsMs, blob, style);
    return { content: attachFooter(content, signedTsMs, blob, style), signedTsMs, mode: used, footer };
}
