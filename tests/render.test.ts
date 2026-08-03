import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeFooter } from "../dsig.desktop/crypto/footer.ts";
import { stripFooterNodes } from "../dsig.desktop/render.ts";
import { element } from "./stubs/webpack-common.ts";

const footer = encodeFooter(1751289600123, Uint8Array.from({ length: 72 }, (_, i) => i));

describe("stripFooterNodes", () => {
    it("removes a footer that renders as a plain string", () => {
        assert.deepEqual(stripFooterNodes(["hello", "\n" + footer]), ["hello"]);
    });

    it("removes a footer glued to the message text", () => {
        assert.deepEqual(stripFooterNodes(["hello\n" + footer]), ["hello"]);
    });

    it("reaches into nested elements", () => {
        const tree = [element("span", ["text\n" + footer])];
        const out = stripFooterNodes(tree) as any[];
        assert.deepEqual(out[0].props.children, ["text"]);
    });

    it("leaves unsigned content untouched", () => {
        const nodes = ["nothing to see", element("em", ["here"])];
        assert.equal(stripFooterNodes(nodes), nodes);
    });

    it("drops the dangling line break the footer leaves behind", () => {
        assert.deepEqual(stripFooterNodes(["hi", "\n", footer]), ["hi"]);
    });

    it("passes non-array content straight through", () => {
        assert.equal(stripFooterNodes("plain"), "plain");
        assert.equal(stripFooterNodes(null), null);
    });

    it("never throws on a malformed tree", () => {
        const cyclic: any[] = ["a"];
        cyclic.push(cyclic);
        assert.doesNotThrow(() => stripFooterNodes(cyclic));
    });
});
