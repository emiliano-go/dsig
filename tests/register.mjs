import { registerHooks } from "node:module";

import { resolve } from "./resolve-hook.mjs";

registerHooks({ resolve });
