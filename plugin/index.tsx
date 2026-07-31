/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — GPG message signing for Vencord / Vesktop.
 *
 * Every outgoing message carries a compact attestation that this account, in
 * this channel, at this moment, wrote this exact text — signed by the user's
 * own GPG key. This is *not* encryption: content stays plaintext on the wire.
 */

import "./styles.css";

import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMessagePreEditListener, addMessagePreSendListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { React, Toasts, UserStore } from "@webpack/common";

import { Badge } from "./components/Badge";
import { logger } from "./crypto/backend";
import { stripFooterNodes } from "./render";
import { settings } from "./settings";
import { shouldSign, signContent } from "./sign";
import { invalidate, loadCache, loadPeers } from "./store";

function warn(reason: string) {
    logger.warn("sending unsigned:", reason);
    Toasts.show({
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        message: `dsig: message sent UNSIGNED — ${reason}`
    });
}

const preSend = async (channelId: string, msg: { content: string; }) => {
    if (!msg.content || !shouldSign(channelId)) return;

    const authorId = UserStore.getCurrentUser()?.id;
    if (!authorId) return warn("current user unknown");

    try {
        const signed = await signContent("o", authorId, channelId, null, msg.content);
        msg.content = signed.content;
    } catch (e) {
        warn((e as Error).message);
    }
};

const preEdit = async (channelId: string, messageId: string, msg: { content: string; }) => {
    if (!msg.content || !shouldSign(channelId)) return;

    const authorId = UserStore.getCurrentUser()?.id;
    if (!authorId) return warn("current user unknown");

    try {
        // The message id exists now, so bind it: an edit signature is only
        // valid for this one message.
        const signed = await signContent("e", authorId, channelId, messageId, msg.content);
        msg.content = signed.content;
        invalidate(messageId);
    } catch (e) {
        warn((e as Error).message);
    }
};

export default definePlugin({
    name: "Dsig",
    description: "Signs your messages with your GPG key and verifies signed messages from peers you have pinned. Not encryption — authorship only.",
    authors: [{ name: "Emiliano Gandini Outeda", id: 0n }],
    settings,

    // Render-time removal of the footer line. Falls back gracefully: if this
    // patch ever stops matching, the footer is simply visible.
    patches: [
        {
            find: '["strong","em","u","text","inlineCode","s","spoiler"]',
            predicate: () => settings.store.hideFooter,
            replacement: {
                match: /(?=return{hasSpoilerEmbeds:\i,hasBailedAst:\i,content:(\i))/,
                replace: (_, content) => `${content}=$self.stripFooterNodes(${content});`
            }
        }
    ],

    stripFooterNodes,

    async start() {
        await Promise.all([loadPeers(), loadCache()]).catch(e => logger.error("failed to load stored data", e));

        addMessagePreSendListener(preSend);
        addMessagePreEditListener(preEdit);
        addMessageDecoration("dsig", props => (
            <ErrorBoundary noop>
                <Badge message={props.message as any} />
            </ErrorBoundary>
        ));
    },

    stop() {
        removeMessagePreSendListener(preSend);
        removeMessagePreEditListener(preEdit);
        removeMessageDecoration("dsig");
    }
});
