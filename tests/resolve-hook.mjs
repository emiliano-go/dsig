/*
 * Lets the test suite import the plugin's own modules.
 *
 * Three gaps to bridge:
 *   • the plugin uses extensionless relative imports ("./crypto/status"), which
 *     esbuild and TypeScript resolve but Node's ESM loader does not;
 *   • Vencord's lint rules require "@plugins/dsig.desktop/…" for anything above
 *     the importing file's own directory, an alias only the bundler knows;
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
const PLUGIN = new URL("../dsig.desktop/", import.meta.url).href;

/** "@plugins/dsig.desktop/crypto/footer" → the file in this repo. */
const PLUGIN_ALIAS = "@plugins/dsig.desktop/";

const ALIASES = {
    "@api/DataStore": STUBS + "DataStore.ts",
    "@webpack/common": STUBS + "webpack-common.ts",
    "@utils/Logger": STUBS + "Logger.ts"
};

/** Plugin modules replaced wholesale because the real ones need a bundler. */
function stubbedPluginModule(resolved) {
    if (/\/dsig\.desktop\/settings$/.test(resolved)) return STUBS + "settings.ts";
    if (/\/dsig\.desktop\/crypto\/backend$/.test(resolved)) return STUBS + "backend.ts";
    return null;
}

export function resolve(specifier, context, next) {
    if (specifier in ALIASES) return next(ALIASES[specifier], context);

    if (specifier.startsWith(".") || specifier.startsWith(PLUGIN_ALIAS)) {
        const base = specifier.startsWith(PLUGIN_ALIAS)
            ? PLUGIN + specifier.slice(PLUGIN_ALIAS.length)
            : context.parentURL && new URL(specifier, context.parentURL).href;
        if (!base) return next(specifier, context);

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
