/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: the chat bar lock.
 *
 * A padlock next to the emoji and gif buttons: closed while outgoing messages
 * are signed, open (and danger-tinted) while they are not. Clicking toggles
 * `signOutgoing`, the same switch the settings panel exposes; the tooltip
 * also says when the current channel is excluded by the channel policy, since
 * then the lock alone cannot tell the whole story.
 */

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import type { IconComponent } from "@utils/types";
import { React } from "@webpack/common";

import { settings } from "../settings";
import { shouldSign } from "../sign";

export const LockIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2Zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0Z"
        />
    </svg>
);

const UnlockIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24">
        <path
            fill="var(--status-danger)"
            d="M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6-9h-1V6A5 5 0 0 0 7 6h1.9a3.1 3.1 0 0 1 6.2 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2Z"
        />
    </svg>
);

export const SignToggle: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    const { signOutgoing, chatBarLock } = settings.use(["signOutgoing", "chatBarLock"]);
    if (!isMainChat || !chatBarLock) return null;

    // The lock shows the global switch; the channel policy can still exclude
    // this particular channel, and then the tooltip says so.
    const excluded = signOutgoing && !shouldSign(channel.id);
    const tooltip = !signOutgoing
        ? "dsig: messages go UNSIGNED. Click to sign."
        : excluded
            ? "dsig: signing is on, but your channel policy excludes this channel"
            : "dsig: messages are signed. Click to stop signing.";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => { settings.store.signOutgoing = !settings.store.signOutgoing; }}
        >
            {signOutgoing ? <LockIcon /> : <UnlockIcon />}
        </ChatBarButton>
    );
};
