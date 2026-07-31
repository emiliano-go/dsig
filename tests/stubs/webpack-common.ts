/*
 * Minimal stand-in for @webpack/common.
 *
 * Only what the non-UI plugin modules touch: a React shim good enough for
 * render.ts's node walking, and the stores sign.ts consults.
 */

const ELEMENT = Symbol.for("react.element");

export const React = {
    isValidElement: (node: any) => !!node && typeof node === "object" && node.$$typeof === ELEMENT,
    cloneElement: (node: any, _props: any, children: any) => ({
        ...node,
        props: { ...node.props, children }
    })
};

/** Build a fake element the shim recognises. */
export function element(type: string, children: any) {
    return { $$typeof: ELEMENT, type, props: { children } };
}

let channels: Record<string, { id: string; type: number; }> = {};

export const ChannelStore = {
    getChannel: (id: string) => channels[id],
    _set(next: Record<string, { id: string; type: number; }>) { channels = next; }
};

export const UserStore = {
    getCurrentUser: () => ({ id: "100000000000000001" })
};

export const Toasts = {
    Type: { FAILURE: 2 },
    genId: () => "1",
    show: () => void 0
};
