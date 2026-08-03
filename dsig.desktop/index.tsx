/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: GPG message signing for Vencord / Vesktop.
 *
 * Every outgoing message carries a compact attestation that this account, in
 * this channel, at this moment, wrote this exact text, signed by the user's
 * own GPG key. This is *not* encryption: content stays plaintext on the wire.
 */

import "./styles.css";

import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMessagePreEditListener, addMessagePreSendListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { FluxDispatcher, React, Toasts, UserStore } from "@webpack/common";

import { Badge } from "./components/Badge";
import { LockIcon, SignToggle } from "./components/SignToggle";
import { logger } from "./crypto/backend";
import { stripHidden, stripHiddenRuns, stripTrailingFooters } from "./crypto/footer";
import { isProbe, isProbe2 } from "./crypto/probe";
import { stripFooterNodes } from "./render";
import { settings } from "./settings";
import { shouldSign, signContent } from "./sign";
import { dropLegacyPrivateKey, invalidate, loadCache, loadPeers } from "./store";

function warn(reason: string) {
    logger.warn("sending unsigned:", reason);
    Toasts.show({
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        message: `dsig: message sent UNSIGNED (${reason})`
    });
}

const preSend = async (channelId: string, msg: { content: string; }) => {
    if (!msg.content || !shouldSign(channelId)) return;

    // A capacity-probe message must reach Discord byte for byte; a footer
    // appended to it would corrupt the very thing it measures.
    if (isProbe(msg.content) || isProbe2(msg.content)) return;

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

/**
 * Keep the footer out of the edit box.
 *
 * Discord fills the editor with the stored message, footer and all. Stripping
 * it there means the user edits their own prose and `preEdit` re-signs it, but
 * only where a signature will actually be put back, or an edit in a channel we
 * do not sign would quietly drop the signature that was already there.
 *
 * Both shapes have to go: the visible ‖dsig line, and the invisible run, which
 * draws nothing but is still there to arrow through and to trip the character
 * counter. In hidden mode the whole alphabet goes, because `signContent`
 * strips it too, so this leaves the box holding exactly what will be signed.
 *
 * Never throws: a failure here would break editing entirely, and a footer left
 * in the box is the harmless outcome.
 */
function stripFooterForEdit(channelId: string, content: string): string {
    try {
        if (typeof content !== "string" || !shouldSign(channelId)) return content;
        const withoutLine = stripTrailingFooters(content);
        return settings.store.footerStyle === "hidden"
            ? stripHidden(withoutLine)
            : stripHiddenRuns(withoutLine);
    } catch (e) {
        logger.error("failed to strip the footer for editing", e);
        return content;
    }
}

/**
 * Discord builds the edit action from its own ActionTypes constants, so there
 * is no `type:"MESSAGE_START_EDIT"` literal in the bundle to patch. An
 * interceptor sees the action whatever route it came by, and edits it in place
 * before the editor is filled.
 */
function interceptEditStart(): (() => void) | null {
    const dispatcher = FluxDispatcher as any;
    if (typeof dispatcher?.addInterceptor !== "function") {
        logger.warn("FluxDispatcher.addInterceptor is missing; the footer will show while editing");
        return null;
    }

    const interceptor = (action: any) => {
        if (action?.type === "MESSAGE_START_EDIT" && typeof action.content === "string")
            action.content = stripFooterForEdit(action.channelId, action.content);
        return false; // never swallow the action
    };

    dispatcher.addInterceptor(interceptor);

    return () => {
        const list = dispatcher._interceptors;
        if (!Array.isArray(list)) return;
        const at = list.indexOf(interceptor);
        if (at >= 0) list.splice(at, 1);
    };
}

let stopIntercepting: (() => void) | null = null;

export default definePlugin({
    name: "Dsig",
    description: "Signs your messages with your GPG key and verifies signed messages from peers you have pinned. Not encryption: authorship only.",
    authors: [{ name: "Emiliano Gandini Outeda", id: 456132385218625543n }],
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

    // The chat bar lock: closed = outgoing messages are signed, open = they
    // are not; clicking toggles it without a trip to the settings panel.
    chatBarButton: {
        icon: LockIcon,
        render: SignToggle
    },

    async start() {
        await Promise.all([loadPeers(), loadCache()]).catch(e => logger.error("failed to load stored data", e));
        // Nothing reads it any more, and it is a private key.
        dropLegacyPrivateKey().catch(e => logger.error("failed to drop the stored openpgp.js key", e));

        addMessagePreSendListener(preSend);
        addMessagePreEditListener(preEdit);
        stopIntercepting = interceptEditStart();
        addMessageDecoration("dsig", props => (
            <ErrorBoundary noop>
                <Badge message={props.message as any} compact={props.compact} />
            </ErrorBoundary>
        ));
    },

    stop() {
        removeMessagePreSendListener(preSend);
        removeMessagePreEditListener(preEdit);
        stopIntercepting?.();
        stopIntercepting = null;
        removeMessageDecoration("dsig");
    }
});
