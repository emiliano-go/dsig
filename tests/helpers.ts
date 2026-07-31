/*
 * Test helpers: an ephemeral GNUPGHOME with a freshly generated Ed25519 key,
 * so the suite never touches the developer's real keyring.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface TestKeyring {
    home: string;
    /** Primary key fingerprint. */
    fpr: string;
    /** Fingerprint that actually signs: the subkey when there is one. */
    signingFpr: string;
    armoredPubkey: string;
    dispose(): void;
}

export const GPG = process.env.DSIG_GPG ?? "gpg";

export function gpgAvailable(): boolean {
    try {
        execFileSync(GPG, ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/**
 * Build a throwaway keyring.
 *
 * `subkey: true` reproduces the recommended real-world setup: a primary key
 * that cannot sign plus a dedicated Ed25519 signing subkey, so the fingerprint
 * a peer is pinned under is *not* the fingerprint that signs.
 */
export function makeKeyring(
    uid = "dsig test <test@dsig.local>",
    algo = "ed25519",
    opts: { subkey?: boolean; } = {}
): TestKeyring {
    const home = mkdtempSync(join(tmpdir(), "dsig-test-"));
    const env = { ...process.env, GNUPGHOME: home, LC_ALL: "C" };
    const gpg = (args: string[]) => execFileSync(GPG, args, { env, encoding: "utf8" });

    gpg(["--batch", "--passphrase", "", "--quick-gen-key", uid, algo, opts.subkey ? "cert" : "sign", "never"]);

    const primaryColons = gpg(["--batch", "--list-secret-keys", "--with-colons"]);
    const fpr = /^fpr:+([0-9A-F]{40}):/m.exec(primaryColons)?.[1];
    if (!fpr) throw new Error("test keyring: no fingerprint");

    let signingFpr = fpr;
    if (opts.subkey) {
        gpg(["--batch", "--passphrase", "", "--quick-add-key", fpr, "ed25519", "sign", "never"]);
        // The signing subkey is the last ssb row with the "s" capability.
        const colons = gpg(["--batch", "--list-secret-keys", "--with-colons", fpr]).split("\n");
        for (let i = 0; i < colons.length; i++) {
            const f = colons[i].split(":");
            if (f[0] === "ssb" && (f[11] ?? "").includes("s")) {
                const next = colons[i + 1]?.split(":");
                if (next?.[0] === "fpr") signingFpr = next[9];
            }
        }
        if (signingFpr === fpr) throw new Error("test keyring: signing subkey not found");
    }

    const armoredPubkey = gpg(["--batch", "--armor", "--export", fpr]);

    return {
        home,
        fpr,
        signingFpr,
        armoredPubkey,
        dispose() {
            try {
                execFileSync(GPG, ["--quiet", "--batch", "--no-autostart", "--homedir", home, "--version"], { stdio: "ignore" });
            } catch { /* ignore */ }
            try {
                execFileSync("gpgconf", ["--homedir", home, "--kill", "all"], { stdio: "ignore" });
            } catch { /* ignore */ }
            rmSync(home, { recursive: true, force: true });
        }
    };
}

/** Run a body with process.env.GNUPGHOME pointed at a keyring. */
export async function withKeyring<T>(kr: TestKeyring, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.GNUPGHOME;
    process.env.GNUPGHOME = kr.home;
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.GNUPGHOME;
        else process.env.GNUPGHOME = prev;
    }
}
