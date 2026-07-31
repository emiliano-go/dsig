/*
 * Stand-in for plugin/settings.tsx.
 *
 * The real module pulls in React settings components, which Node cannot load;
 * every consumer only ever reads `settings.store`, so a plain object is a
 * faithful substitute. Defaults mirror settings.tsx — keep them in sync.
 */

export const defaults = {
    signOutgoing: true,
    signingKey: "",
    signMode: "compact",
    signChannels: "all",
    channelAllowlist: "",
    verifyIncoming: true,
    verifyUnknownKeys: true,
    clockToleranceSec: 10,
    onSkew: "warn",
    backend: "gpg",
    gpgPath: "gpg",
    hideFooter: true,
    badgeStyle: "pill"
};

export const settings = {
    store: { ...defaults } as Record<string, any>,
    use: () => settings.store
};

export function resetSettings(): void {
    settings.store = { ...defaults };
}
