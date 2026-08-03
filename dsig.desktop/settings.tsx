/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: settings schema.
 *
 * Only scalar preferences live here. Pinned peer keys and the verify cache are
 * data, and live in DataStore (see store.ts).
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { KeyPicker } from "./components/KeyPicker";
import { PeerManager } from "./components/PeerManager";
import { TestPanel } from "./components/TestPanel";

export const settings = definePluginSettings({
    // ── Signing ──────────────────────────────────────────
    signOutgoing: {
        type: OptionType.BOOLEAN,
        description: "Sign my outgoing messages",
        default: true
    },
    signingKey: {
        type: OptionType.COMPONENT,
        description: "Signing key",
        component: KeyPicker,
        default: ""
    },
    signMode: {
        type: OptionType.SELECT,
        description: "Signature format",
        options: [
            { label: "Compact (plugin-only, ~110 char footer)", value: "compact", default: true },
            { label: "Armored (any GPG can verify, ~175 char footer)", value: "armored" }
        ]
    },
    footerStyle: {
        type: OptionType.SELECT,
        description: "How the footer looks to people without the plugin",
        options: [
            { label: "Small grey line under the message (recommended)", value: "subtext", default: true },
            { label: "Plain line of text", value: "plain" },
            { label: "Invisible: nothing visible at all; works for any message length", value: "hidden" }
        ]
    },
    chatBarLock: {
        type: OptionType.BOOLEAN,
        description: "Show a lock in the chat bar that toggles signing",
        default: true
    },
    signChannels: {
        type: OptionType.SELECT,
        description: "Where to sign",
        options: [
            { label: "Everywhere", value: "all", default: true },
            { label: "DMs only", value: "dm" },
            { label: "Only channels on an allowlist", value: "allowlist" }
        ]
    },
    channelAllowlist: {
        type: OptionType.STRING,
        description: "Allowlisted channel IDs (comma-separated), if allowlist mode",
        default: ""
    },

    // ── Verification ─────────────────────────────────────
    verifyIncoming: {
        type: OptionType.BOOLEAN,
        description: "Verify incoming signed messages",
        default: true
    },
    peerKeys: {
        type: OptionType.COMPONENT,
        description: "Trusted peer keys",
        component: PeerManager
    },
    verifyUnknownKeys: {
        type: OptionType.BOOLEAN,
        description: "Show an 'unknown signer' badge for signatures from unpinned keys",
        default: true
    },

    // ── Timestamp binding ────────────────────────────────
    clockToleranceSec: {
        type: OptionType.SLIDER,
        description: "Max allowed drift between the signed time and Discord's own timestamp (seconds)",
        markers: [2, 5, 10, 30, 60],
        default: 10,
        stickToMarkers: false
    },
    onSkew: {
        type: OptionType.SELECT,
        description: "When the signed time exceeds the tolerance",
        options: [
            { label: "Show a warning badge, keep it valid", value: "warn", default: true },
            { label: "Treat as invalid", value: "fail" }
        ]
    },

    // ── Backend ──────────────────────────────────────────
    gpgPath: {
        type: OptionType.STRING,
        description: "Path to the gpg binary",
        default: "gpg"
    },

    // ── Display ──────────────────────────────────────────
    hideFooter: {
        type: OptionType.BOOLEAN,
        description: "Hide the raw signature footer, show only the badge",
        default: true,
        restartNeeded: true
    },
    badgeStyle: {
        type: OptionType.SELECT,
        description: "Badge style",
        options: [
            { label: "Pill with label", value: "pill", default: true },
            { label: "Icon only", value: "icon" }
        ]
    },

    // ── Diagnostics ──────────────────────────────────────
    testPanel: {
        type: OptionType.COMPONENT,
        description: "Sign & verify a test string",
        component: TestPanel
    },
    /** Set by the capacity probe; the characters the long-run probe targets. */
    probeSurvivors: {
        type: OptionType.STRING,
        description: "",
        default: "",
        hidden: true
    }
});
