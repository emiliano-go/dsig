/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: diagnostics.
 *
 * Runs the exact pipeline a real message goes through (canonicalise → payload
 * → sign → compact → footer → parse → inflate → verify) against the selected
 * key, without touching Discord. This is the fastest way to tell a broken
 * backend apart from a broken Discord integration.
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { ChannelStore, MessageStore, React, SelectedChannelStore, TextInput, UserStore, useState } from "@webpack/common";

import { getBackend } from "../crypto/backend";
import { encodeFooter, extractFooter, hasFooter, hasHiddenRun, hiddenReport } from "../crypto/footer";
import { compress, inflate, isCompact, signerFingerprint } from "../crypto/packet";
import { buildPayload, canonicalizeContent } from "../crypto/payload";
import { analyzeProbe, analyzeProbe2, buildProbe, buildProbe2, CANDIDATES, isProbe, isProbe2, REPEATS } from "../crypto/probe";
import { settings } from "../settings";
import { getPeer, groupFingerprint } from "../store";
import { verifyMessage } from "../verify";
import { cl } from "./Badge";

const SELF_ID = "100000000000000001";
const SELF_CHANNEL = "100000000000000002";

interface Line { ok: boolean; text: string; }


/** The tail of a string spelled out, so invisible characters can be seen. */
function codepoints(content: string, count: number): string {
    return [...content]
        .slice(-count)
        .map(ch => {
            const cp = ch.codePointAt(0)!;
            return cp > 32 && cp < 127 ? ch : "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
        })
        .join(" ");
}

/** Which shape of footer, if any, is sitting in this content. */
function footerStyleOf(content: string): string {
    if (hasHiddenRun(content)) return "invisible";
    if (/^-# \u2016dsig:1:/m.test(content)) return "small grey line (subtext)";
    if (/^\u2016dsig:1:/m.test(content)) return "plain line";
    return "none";
}

/**
 * Read back the last message this account actually sent, as Discord stored it.
 *
 * The pipeline test above proves the crypto works; this proves what survived
 * the round trip, which is the other half and the one that cannot be checked
 * without a real channel.
 */
async function inspectLastOwnMessage(): Promise<Line[]> {
    const out: Line[] = [];

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return [{ ok: false, text: "open a channel first, then run this" }];

    const me = UserStore.getCurrentUser()?.id;
    const all = MessageStore.getMessages(channelId)?.toArray?.() ?? [];
    const mine = all.filter((m: any) => m.author?.id === me);
    const message = mine[mine.length - 1];

    if (!message) return [{ ok: false, text: "no message from you in this channel yet; send one and run this again" }];

    const channel = ChannelStore.getChannel(channelId);
    const content: string = message.content ?? "";
    const style = footerStyleOf(content);

    out.push({ ok: true, text: `last message ${message.id} in ${channel?.name ? "#" + channel.name : channelId}` });
    out.push({ ok: style !== "none", text: `footer found: ${style}` });
    out.push({ ok: hasFooter(content), text: `parses as a footer: ${hasFooter(content)}` });
    out.push({ ok: true, text: `stored content ends: ${JSON.stringify(content.slice(-90))}` });
    out.push({ ok: true, text: `length ${content.length} chars, ${[...content].length} codepoints` });
    out.push({ ok: true, text: `last codepoints: ${codepoints(content, 12)}` });

    const hidden = hiddenReport(content);
    if (hidden.symbols > 0) {
        out.push({
            ok: hidden.reason === "decodes",
            text: `invisible footer: ${hidden.symbols} symbols` +
                (hidden.declaredLength != null ? `, ${hidden.gotLength}/${hidden.declaredLength} bytes` : "") +
                ` - ${hidden.reason}`
        });
    }

    const verdict = await verifyMessage(message);
    out.push({
        ok: verdict.status === "valid",
        text: `badge would show: ${verdict.status}${verdict.detail ? " (" + verdict.detail + ")" : ""}`
    });

    if (style === "none")
        out.push({ ok: false, text: "the footer is gone: it never reached the server, or the server dropped it." });

    return out;
}

/** The last message this account sent in the open channel, or null. */
function lastOwnMessage(): { id: string; content: string; } | null {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return null;
    const me = UserStore.getCurrentUser()?.id;
    const mine = (MessageStore.getMessages(channelId)?.toArray?.() ?? []).filter((m: any) => m.author?.id === me);
    const message = mine[mine.length - 1];
    return message ? { id: message.id, content: message.content ?? "" } : null;
}

/**
 * Read back a sent probe and report which invisible characters Discord kept.
 * This is the measurement that replaces guessing at an invisible encoding.
 */
function analyzeSentProbe(): Line[] {
    const message = lastOwnMessage();
    if (!message) return [{ ok: false, text: "no message from you in this channel yet; send the probe first" }];

    if (isProbe2(message.content)) {
        const survivors = JSON.parse(settings.store.probeSurvivors || "[]") as string[];
        const r = analyzeProbe2(message.content, survivors);
        return [
            { ok: r.orderPreserved, text: `long-run probe: ${r.survived}/${r.sent} survived, order ${r.orderPreserved ? "kept" : "broken"}` },
            { ok: r.orderPreserved, text: r.verdict }
        ];
    }

    if (!isProbe(message.content))
        return [{ ok: false, text: `last message is not a probe (send the copied probe string). It starts: ${JSON.stringify(message.content.slice(0, 16))}` }];

    const report = analyzeProbe(message.content);
    const lines: Line[] = report.results.map(r => ({
        ok: r.survived === r.sent,
        text: `${r.name}: ${r.survived}/${r.sent}${r.segmentIntact ? "" : " (segment delimiters lost)"}`
    }));
    lines.push({ ok: report.stackKept > 4, text: `per-base cap: ${report.stackKept}/${report.stackSent} selectors kept on one character` });
    lines.push({ ok: report.spreadKept === report.spreadSent, text: `total cap: ${report.spreadKept}/${report.spreadSent} selectors kept across 30 characters` });
    lines.push({ ok: report.survivingBases.length > 0, text: report.verdict });

    // Remember the surviving zero-width base characters so the long-run probe
    // can stress exactly those.
    const survivors = CANDIDATES
        .filter((c, i) => c.role === "base" && c.zeroWidth && report.results[i].survived === REPEATS)
        .map(c => c.char);
    settings.store.probeSurvivors = JSON.stringify(survivors);
    return lines;
}

export function TestPanel() {
    const [text, setText] = useState("hello from dsig");
    const [lines, setLines] = useState<Line[]>([]);
    const [busy, setBusy] = useState(false);

    /** Report on the last message this account sent, as Discord stored it. */
    async function inspect() {
        setBusy(true);
        try {
            setLines(await inspectLastOwnMessage());
        } catch (e) {
            setLines([{ ok: false, text: (e as Error).message }]);
        } finally {
            setBusy(false);
        }
    }

    async function copy(build: () => string, label: string) {
        try {
            await navigator.clipboard.writeText(build());
            setLines([{ ok: true, text: `${label} copied. Paste and send it in any channel, then click Analyze last message.` }]);
        } catch (e) {
            setLines([{ ok: false, text: `could not copy: ${(e as Error).message}` }]);
        }
    }

    function analyze() {
        setBusy(true);
        try {
            setLines(analyzeSentProbe());
        } catch (e) {
            setLines([{ ok: false, text: (e as Error).message }]);
        } finally {
            setBusy(false);
        }
    }

    const survivors = (() => {
        try { return JSON.parse(settings.store.probeSurvivors || "[]") as string[]; } catch { return []; }
    })();

    async function run() {
        setBusy(true);
        const out: Line[] = [];
        const started = performance.now();
        try {
            const backend = getBackend();
            const keyFpr = String(settings.store.signingKey ?? "");
            if (!keyFpr) throw new Error("no signing key selected");

            const content = canonicalizeContent(text);
            const ts = Date.now();
            const payload = buildPayload("o", SELF_ID, SELF_CHANNEL, null, ts, content);

            const signStart = performance.now();
            const sig = await backend.sign(payload, keyFpr);
            const signMs = performance.now() - signStart;
            out.push({ ok: true, text: `signed in ${signMs.toFixed(0)} ms (${sig.length} byte packet)` });

            const compact = settings.store.signMode === "compact" ? compress(sig) : null;
            if (settings.store.signMode === "compact") {
                out.push(compact
                    ? { ok: true, text: `compacted to ${compact.length} bytes` }
                    : { ok: false, text: "not compressible; messages will use the larger armored form" });
            }

            const blob = compact ?? sig;
            const footer = encodeFooter(ts, blob);
            out.push({ ok: footer.length <= 200, text: `footer is ${footer.length} chars: ${footer.slice(0, 24)}…` });

            // ── receiver side, using only what travels on the wire ──
            const wire = content + "\n" + footer;
            const parsed = extractFooter(wire);
            if (!parsed) throw new Error("the footer we just wrote does not parse back");
            if (canonicalizeContent(parsed.body) !== content) throw new Error("content did not survive the round trip");
            out.push({ ok: true, text: "footer parses back and content round-trips" });

            const ownFpr = keyFpr.replace(/!$/, "").toUpperCase();
            const declared = isCompact(parsed.blob) ? ownFpr : signerFingerprint(parsed.blob) ?? ownFpr;
            const packet = isCompact(parsed.blob) ? inflate(parsed.blob, ownFpr) : parsed.blob;

            // Verifying needs a *public* key. Use a pinned copy of our own key
            // when there is one, otherwise fall back to the local keyring.
            const pinned = getPeer(declared);
            const recomputed = buildPayload("o", SELF_ID, SELF_CHANNEL, null, parsed.signedTsMs, canonicalizeContent(parsed.body));
            const verifyStart = performance.now();
            const res = await backend.verify(recomputed, packet, pinned?.armoredPubkey ?? "");
            const verifyMs = performance.now() - verifyStart;

            out.push({
                ok: res.good,
                text: res.good
                    ? `verified in ${verifyMs.toFixed(0)} ms as ${groupFingerprint(res.signerFpr ?? declared)}`
                    : `verification failed: ${res.error ?? "unknown reason"}${pinned ? "" : " (pin your own public key to test the full path)"}`
            });

            // Negative control: tampering must break it.
            const tampered = buildPayload("o", SELF_ID, SELF_CHANNEL, null, parsed.signedTsMs, content + "!");
            const bad = await backend.verify(tampered, packet, pinned?.armoredPubkey ?? "");
            out.push({ ok: !bad.good, text: bad.good ? "TAMPERED CONTENT STILL VERIFIED: do not trust this setup" : "tampered content correctly rejected" });

            out.push({ ok: true, text: `backend: ${backend.name} · total ${(performance.now() - started).toFixed(0)} ms` });
        } catch (e) {
            out.push({ ok: false, text: (e as Error).message });
        } finally {
            setLines(out);
            setBusy(false);
        }
    }

    return (
        <div className={cl("section")}>
            <div className={cl("row")}>
                <TextInput value={text} placeholder="Test message" onChange={setText} />
                <Button disabled={busy} onClick={run}>{busy ? "Working…" : "Sign & verify"}</Button>
                <Button disabled={busy} onClick={inspect}>Check my last message</Button>
            </div>

            <Paragraph className={cl("muted")}>
                Capacity probe: measure which invisible characters survive Discord. Copy the probe,
                send it in a private channel, then Analyze; the result says whether an invisible
                signature is possible at all.
            </Paragraph>
            <div className={cl("row")}>
                <Button disabled={busy} onClick={() => copy(buildProbe, "Probe")}>Copy probe</Button>
                <Button disabled={busy} onClick={analyze}>Analyze last message</Button>
                {survivors.length > 0 && (
                    <Button disabled={busy} onClick={() => copy(() => buildProbe2(survivors), "Long-run probe")}>
                        Copy long-run probe
                    </Button>
                )}
            </div>

            {lines.map((l, i) => (
                <Paragraph key={i} className={cl(l.ok ? "ok-text" : "error-text")}>
                    {l.ok ? "✓" : "✗"} {l.text}
                </Paragraph>
            ))}
        </div>
    );
}
