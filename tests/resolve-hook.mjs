/*
 * Lets the test suite import the plugin's own modules.
 *
 * Two gaps to bridge:
 *   • the plugin uses extensionless relative imports ("./crypto/status"), which
 *     esbuild and TypeScript resolve but Node's ESM loader does not;
 *   • it imports Vencord aliases ("@webpack/common") and two modules that pull
 *     in React components, which cannot load outside a bundler.
 *
 * Both are mapped to stubs here, for tests only; the shipped plugin is
 * untouched. Modules with real logic (payload, footer, packet, store, sign,
 * verify, native) are always the genuine article.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

const STUBS = new URL("./stubs/", import.meta.url).href;

const ALIASES = {
    "@api/DataStore": STUBS + "DataStore.ts",
    "@webpack/common": STUBS + "webpack-common.ts",
    "@utils/Logger": STUBS + "Logger.ts"
};

/** Plugin modules replaced wholesale because the real ones need a bundler. */
function stubbedPluginModule(resolved) {
    if (/\/plugin\/settings$/.test(resolved)) return STUBS + "settings.ts";
    if (/\/plugin\/crypto\/backend$/.test(resolved)) return STUBS + "backend.ts";
    return null;
}

export function resolve(specifier, context, next) {
    if (specifier in ALIASES) return next(ALIASES[specifier], context);

    if (specifier.startsWith(".") && context.parentURL) {
        const base = new URL(specifier, context.parentURL).href;

        const stub = stubbedPluginModule(base.replace(/\.tsx?$/, ""));
        if (stub) return next(stub, context);

        if (!/\.[cm]?[jt]sx?$/.test(specifier)) {
            for (const ext of CANDIDATES) {
                if (existsSync(fileURLToPath(base + ext))) return next(base + ext, context);
            }
        }
    }

    return next(specifier, context);
}
