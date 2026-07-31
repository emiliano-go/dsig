/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig — main-process gpg bridge.
 *
 * Everything here runs outside the renderer. The secret key never leaves
 * gpg-agent; only payloads, signatures and public keys cross IPC.
 *
 * Hard rules:
 *   • every user-controlled value is an argv array element, never interpolated
 *     into a shell string (no shell is ever spawned)
 *   • payload/signature go through stdin or 0600 temp files under the OS temp
 *     dir, with unpredictable names, unlinked in `finally`
 *   • verification decisions come from --status-fd, never from the exit code
 */

import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { parseStatus } from "./crypto/status";
import type { KeyInfo, VerifyNativeResult } from "./types";

const TIMEOUT_MS = 20_000;

interface RunResult {
    code: number | null;
    stdout: Buffer;
    stderr: string;
    status: string;
}

function sanitizeGpgPath(gpgPath: string): string {
    const p = (gpgPath || "gpg").trim();
    // A path is fine; shell metacharacters are not — nothing here is ever run
    // through a shell, but reject them anyway so a mistyped setting fails loudly.
    if (/[;&|`$<>\n\r"']/.test(p)) throw new Error("dsig: refusing suspicious gpg path");
    return p;
}

/**
 * Spawn gpg with an argv array. `--status-fd 3` output is collected separately
 * from stderr so it can be parsed without human-readable noise.
 */
function run(gpgPath: string, args: string[], stdin?: Buffer | string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(sanitizeGpgPath(gpgPath), args, {
            stdio: ["pipe", "pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
            env: { ...process.env, ...env, LC_ALL: "C" }
        });

        const out: Buffer[] = [];
        let err = "";
        let status = "";

        child.stdout.on("data", d => out.push(d));
        child.stderr.on("data", d => { err += d.toString(); });
        (child.stdio[3] as NodeJS.ReadableStream | undefined)?.on("data", d => { status += d.toString(); });

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`dsig: gpg timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);

        child.on("error", e => {
            clearTimeout(timer);
            reject(new Error(`dsig: cannot run "${gpgPath}": ${(e as Error).message}`));
        });

        child.on("close", code => {
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(out), stderr: err, status });
        });

        if (stdin !== undefined) child.stdin.end(stdin);
        else child.stdin.end();
    });
}

const BASE_ARGS = ["--batch", "--no-tty", "--yes", "--status-fd", "3"];

// ── keyring listing ───────────────────────────────────────────────────────

const ALGO_NAMES: Record<number, string> = {
    1: "rsa", 16: "elgamal", 17: "dsa", 18: "ecdh", 19: "ecdsa", 22: "eddsa"
};

function algoLabel(algoId: number, bits: string, curve: string): string {
    if (curve) return curve;
    const base = ALGO_NAMES[algoId] ?? `algo${algoId}`;
    return bits ? `${base}${bits}` : base;
}

function parseColons(text: string): KeyInfo[] {
    const keys: KeyInfo[] = [];
    let pending: KeyInfo | null = null;
    let primaryUids: string[] = [];

    const flush = () => {
        if (pending) keys.push(pending);
        pending = null;
    };

    for (const line of text.split("\n")) {
        const f = line.split(":");
        switch (f[0]) {
            case "sec":
            case "pub":
                flush();
                primaryUids = [];
                pending = {
                    fingerprint: "",
                    algo: algoLabel(Number(f[3]), f[2], f[16] ?? ""),
                    algoId: Number(f[3]),
                    uids: primaryUids,
                    canSign: (f[11] ?? "").includes("s"),
                    isSubkey: false,
                    created: Number(f[5]) || 0,
                    expires: Number(f[6]) || 0
                };
                break;
            case "ssb":
            case "sub":
                flush();
                pending = {
                    fingerprint: "",
                    algo: algoLabel(Number(f[3]), f[2], f[16] ?? ""),
                    algoId: Number(f[3]),
                    uids: primaryUids,
                    canSign: (f[11] ?? "").includes("s"),
                    isSubkey: true,
                    created: Number(f[5]) || 0,
                    expires: Number(f[6]) || 0
                };
                break;
            case "fpr":
                if (pending && !pending.fingerprint) pending.fingerprint = (f[9] ?? "").toUpperCase();
                break;
            case "uid":
                if (f[9]) primaryUids.push(unescapeColons(f[9]));
                break;
        }
    }
    flush();
    return keys.filter(k => k.fingerprint);
}

function unescapeColons(s: string): string {
    return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Signing-capable keys and subkeys from the local secret keyring. */
export async function listSecretKeys(_: unknown, gpgPath: string): Promise<KeyInfo[]> {
    const res = await run(gpgPath, [
        ...BASE_ARGS,
        "--list-secret-keys",
        "--with-colons",
        "--with-fingerprint",
        "--with-fingerprint"
    ]);
    if (res.code !== 0 && !res.stdout.length)
        throw new Error(`dsig: gpg --list-secret-keys failed: ${res.stderr.trim() || res.code}`);

    return parseColons(res.stdout.toString("utf8")).filter(k => k.canSign);
}

// ── signing ───────────────────────────────────────────────────────────────

/**
 * Detach-sign `payload` with `keyFpr` (append "!" to pin an exact subkey).
 * Returns the raw signature packet.
 */
export async function sign(_: unknown, gpgPath: string, keyFpr: string, payload: string): Promise<number[]> {
    if (!/^[0-9A-Fa-f]{16,40}!?$/.test(keyFpr))
        throw new Error("dsig: signing key must be a hex fingerprint or key id");

    const res = await run(gpgPath, [
        ...BASE_ARGS,
        "--detach-sign",
        "--digest-algo", "SHA512",
        "--local-user", keyFpr,
        "--output", "-"
    ], Buffer.from(payload, "utf8"));

    if (res.code !== 0 || res.stdout.length === 0)
        throw new Error(`dsig: signing failed: ${firstUsefulLine(res.stderr) || `gpg exited ${res.code}`}`);

    // Structured arrays survive Electron IPC; typed arrays do not, reliably.
    return Array.from(res.stdout);
}

function firstUsefulLine(stderr: string): string {
    return stderr
        .split("\n")
        .map(l => l.replace(/^gpg: /, "").trim())
        .filter(Boolean)
        .slice(-2)
        .join("; ");
}

// ── verification ──────────────────────────────────────────────────────────

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), "dsig-"));
    try {
        return await fn(home);
    } finally {
        await rm(home, { recursive: true, force: true }).catch(() => void 0);
    }
}

/**
 * Verify `sigBytes` over `payload`. When `pubkeyArmored` is given the check
 * runs against an ephemeral keyring holding only that key, so the result can
 * never be satisfied by some unrelated key in the user's real keyring.
 */
export async function verify(
    _: unknown,
    gpgPath: string,
    payload: string,
    sigBytes: number[],
    pubkeyArmored?: string
): Promise<VerifyNativeResult> {
    return withTempHome(async home => {
        const sigFile = join(home, "s.sig");
        const msgFile = join(home, "m.txt");
        await writeFile(sigFile, Buffer.from(sigBytes), { mode: 0o600 });
        await writeFile(msgFile, Buffer.from(payload, "utf8"), { mode: 0o600 });

        const env = pubkeyArmored ? { GNUPGHOME: home } : undefined;
        const common = pubkeyArmored ? ["--no-autostart", "--trust-model", "always"] : [];

        if (pubkeyArmored) {
            const keyFile = join(home, "k.asc");
            await writeFile(keyFile, pubkeyArmored, { mode: 0o600 });
            const imported = await run(gpgPath, [...BASE_ARGS, ...common, "--import", keyFile], undefined, env);
            if (!/IMPORT_OK|IMPORT_RES/.test(imported.status))
                return { good: false, error: `could not import peer key: ${firstUsefulLine(imported.stderr)}` };
        }

        const res = await run(gpgPath, [...BASE_ARGS, ...common, "--verify", sigFile, msgFile], undefined, env);
        const parsed = parseStatus(res.status);
        return {
            good: parsed.good,
            signerFpr: parsed.signerFpr,
            error: parsed.good ? undefined : parsed.reason ?? firstUsefulLine(res.stderr)
        };
    });
}

// ── peer key inspection ───────────────────────────────────────────────────

/**
 * Read every key in an armored public key blob (primary first, then subkeys)
 * **without** touching the user's keyring.
 */
export async function importPubkeyKeys(_: unknown, gpgPath: string, armored: string): Promise<KeyInfo[]> {
    return withTempHome(async home => {
        const keyFile = join(home, "k.asc");
        await writeFile(keyFile, armored, { mode: 0o600 });

        const res = await run(gpgPath, [
            ...BASE_ARGS,
            "--no-autostart",
            "--dry-run",
            "--with-colons",
            "--import-options", "show-only",
            "--import", keyFile
        ], undefined, { GNUPGHOME: home });

        const keys = parseColons(res.stdout.toString("utf8"));
        if (!keys.some(k => !k.isSubkey))
            throw new Error(`dsig: not a usable public key: ${firstUsefulLine(res.stderr) || "no key found"}`);

        return keys;
    });
}

/**
 * Summary of an armored public key: the primary key, with `canSign` reflecting
 * whether *anything* in the blob can sign.
 */
export async function importPubkeyInfo(_: unknown, gpgPath: string, armored: string): Promise<KeyInfo> {
    const keys = await importPubkeyKeys(null, gpgPath, armored);
    const primary = keys.find(k => !k.isSubkey)!;
    return { ...primary, canSign: keys.some(k => k.canSign) };
}

/**
 * Export one of your *public* keys in armored form, so it can be pinned as a
 * peer (your own messages need this too) or handed to someone else.
 */
export async function exportPubkey(_: unknown, gpgPath: string, keyFpr: string): Promise<string> {
    const fpr = keyFpr.replace(/!$/, "");
    if (!/^[0-9A-Fa-f]{16,40}$/.test(fpr))
        throw new Error("dsig: key must be a hex fingerprint or key id");

    const res = await run(gpgPath, [...BASE_ARGS, "--armor", "--export", fpr]);
    const armored = res.stdout.toString("utf8");
    if (!armored.includes("BEGIN PGP PUBLIC KEY BLOCK"))
        throw new Error(`dsig: could not export ${fpr}: ${firstUsefulLine(res.stderr) || "no such key"}`);

    return armored;
}

/** Is a working gpg reachable? Used by the settings UI to explain failures. */
export async function probe(_: unknown, gpgPath: string): Promise<{ ok: boolean; version?: string; error?: string; }> {
    try {
        const res = await run(gpgPath, ["--version"]);
        const version = res.stdout.toString("utf8").split("\n")[0]?.trim();
        return res.code === 0 ? { ok: true, version } : { ok: false, error: firstUsefulLine(res.stderr) };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}
