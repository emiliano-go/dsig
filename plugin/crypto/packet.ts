/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Emiliano Gandini Outeda
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * dsig: OpenPGP v4 signature packet surgery (RFC 4880 §5.2.3).
 *
 * Compact mode drops everything a verifier can reconstruct, keeping only:
 *
 *   [0x01][hashAlgo][created BE32][digestPrefix×2][r×32][s×32]  = 72 bytes
 *
 * which is 96 base64 chars against ~160 for the raw packet. Reconstruction
 * needs the signer's fingerprint, which the verifier already has (it is the
 * pinned peer key it is testing against).
 *
 * Only the exact layout GnuPG emits for a detached Ed25519 signature can be
 * compressed. Anything else round-trips unchanged as a raw packet; callers
 * are expected to verify compressibility with `roundTrips()` at sign time and
 * fall back to armored mode when it fails.
 *
 * Dependency-free.
 */

export const COMPACT_TAG = 0x01;
export const COMPACT_LEN = 72;

export const SIGTYPE_BINARY = 0x00;
export const ALGO_EDDSA = 22;

const SUBPKT_CREATED = 2;
const SUBPKT_ISSUER_KEYID = 16;
const SUBPKT_ISSUER_FPR = 33;

export interface Subpacket {
    type: number;
    data: Uint8Array;
}

export interface SignaturePacket {
    version: number;
    sigType: number;
    pubAlgo: number;
    hashAlgo: number;
    hashed: Subpacket[];
    unhashed: Subpacket[];
    digestPrefix: Uint8Array; // 2 bytes
    mpis: Uint8Array[]; // unpadded big-endian integers
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function hex(bytes: Uint8Array): string {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function unhex(s: string): Uint8Array {
    const clean = s.replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2) throw new Error("dsig: odd-length hex");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

/** True when the blob looks like a raw OpenPGP packet rather than a compact blob. */
export function isRawPacket(blob: Uint8Array): boolean {
    const ctb = blob[0];
    // old format, tag 2 (signature), any length type
    if ((ctb & 0xc0) === 0x80 && ((ctb >> 2) & 0x0f) === 2) return true;
    // new format, tag 2
    if (ctb === 0xc2) return true;
    return false;
}

export function isCompact(blob: Uint8Array): boolean {
    return blob.length === COMPACT_LEN && blob[0] === COMPACT_TAG;
}

// ── packet framing ────────────────────────────────────────────────────────

/** Strip the packet header, returning the signature packet body. */
export function unwrapPacket(bytes: Uint8Array): Uint8Array {
    const ctb = bytes[0];
    if (ctb === 0xc2) {
        const l = bytes[1];
        if (l < 192) return bytes.subarray(2, 2 + l);
        if (l < 224) return bytes.subarray(3, 3 + (((l - 192) << 8) + bytes[2] + 192));
        if (l === 0xff) {
            const len = (bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
            return bytes.subarray(6, 6 + len);
        }
        throw new Error("dsig: partial-length signature packets are not supported");
    }
    if ((ctb & 0xc0) !== 0x80 || ((ctb >> 2) & 0x0f) !== 2)
        throw new Error("dsig: not an OpenPGP signature packet");

    switch (ctb & 0x03) {
        case 0: return bytes.subarray(2, 2 + bytes[1]);
        case 1: return bytes.subarray(3, 3 + ((bytes[1] << 8) | bytes[2]));
        case 2: return bytes.subarray(5, 5 + ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]));
        default: throw new Error("dsig: indeterminate-length signature packets are not supported");
    }
}

/** Wrap a signature packet body in an old-format header, as GnuPG does. */
export function wrapPacket(body: Uint8Array): Uint8Array {
    if (body.length < 256) {
        const out = new Uint8Array(2 + body.length);
        out[0] = 0x88;
        out[1] = body.length;
        out.set(body, 2);
        return out;
    }
    if (body.length < 65536) {
        const out = new Uint8Array(3 + body.length);
        out[0] = 0x89;
        out[1] = body.length >> 8;
        out[2] = body.length & 0xff;
        out.set(body, 3);
        return out;
    }
    const out = new Uint8Array(5 + body.length);
    out[0] = 0x8a;
    new DataView(out.buffer).setUint32(1, body.length);
    out.set(body, 5);
    return out;
}

// ── subpackets & MPIs ─────────────────────────────────────────────────────

function parseSubpackets(area: Uint8Array): Subpacket[] {
    const out: Subpacket[] = [];
    let i = 0;
    while (i < area.length) {
        let len: number;
        if (area[i] < 192) {
            len = area[i];
            i += 1;
        } else if (area[i] < 255) {
            len = ((area[i] - 192) << 8) + area[i + 1] + 192;
            i += 2;
        } else {
            len = (area[i + 1] << 24) | (area[i + 2] << 16) | (area[i + 3] << 8) | area[i + 4];
            i += 5;
        }
        if (len < 1 || i + len > area.length) throw new Error("dsig: malformed subpacket area");
        out.push({ type: area[i], data: area.subarray(i + 1, i + len) });
        i += len;
    }
    return out;
}

function encodeSubpackets(subs: Subpacket[]): Uint8Array {
    const parts: number[] = [];
    for (const s of subs) {
        const len = s.data.length + 1;
        if (len < 192) parts.push(len);
        else if (len < 8384) parts.push((((len - 192) >> 8) + 192), (len - 192) & 0xff);
        else parts.push(255, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
        parts.push(s.type, ...s.data);
    }
    return Uint8Array.from(parts);
}

function encodeMpi(value: Uint8Array): Uint8Array {
    let start = 0;
    while (start < value.length && value[start] === 0) start++;
    const body = value.subarray(start);
    if (body.length === 0) return Uint8Array.from([0, 0]);
    const bits = (body.length - 1) * 8 + (32 - Math.clz32(body[0]));
    const out = new Uint8Array(2 + body.length);
    out[0] = bits >> 8;
    out[1] = bits & 0xff;
    out.set(body, 2);
    return out;
}

// ── parse / serialise ─────────────────────────────────────────────────────

export function parseSignature(packetBytes: Uint8Array): SignaturePacket {
    const b = unwrapPacket(packetBytes);
    const version = b[0];
    if (version !== 4) throw new Error(`dsig: unsupported signature version ${version}`);

    const hashedLen = (b[4] << 8) | b[5];
    let i = 6;
    const hashed = parseSubpackets(b.subarray(i, i + hashedLen));
    i += hashedLen;

    const unhashedLen = (b[i] << 8) | b[i + 1];
    i += 2;
    const unhashed = parseSubpackets(b.subarray(i, i + unhashedLen));
    i += unhashedLen;

    const digestPrefix = b.subarray(i, i + 2);
    i += 2;

    const mpis: Uint8Array[] = [];
    while (i + 2 <= b.length) {
        const bits = (b[i] << 8) | b[i + 1];
        const len = (bits + 7) >> 3;
        i += 2;
        if (i + len > b.length) throw new Error("dsig: truncated MPI");
        mpis.push(b.subarray(i, i + len));
        i += len;
    }

    return {
        version,
        sigType: b[1],
        pubAlgo: b[2],
        hashAlgo: b[3],
        hashed,
        unhashed,
        digestPrefix,
        mpis
    };
}

export function serializeSignature(sig: SignaturePacket): Uint8Array {
    const hashed = encodeSubpackets(sig.hashed);
    const unhashed = encodeSubpackets(sig.unhashed);
    const mpis = sig.mpis.map(encodeMpi);
    const mpiLen = mpis.reduce((n, m) => n + m.length, 0);

    const body = new Uint8Array(6 + hashed.length + 2 + unhashed.length + 2 + mpiLen);
    body[0] = sig.version;
    body[1] = sig.sigType;
    body[2] = sig.pubAlgo;
    body[3] = sig.hashAlgo;
    body[4] = hashed.length >> 8;
    body[5] = hashed.length & 0xff;
    let i = 6;
    body.set(hashed, i); i += hashed.length;
    body[i++] = unhashed.length >> 8;
    body[i++] = unhashed.length & 0xff;
    body.set(unhashed, i); i += unhashed.length;
    body.set(sig.digestPrefix.subarray(0, 2), i); i += 2;
    for (const m of mpis) { body.set(m, i); i += m.length; }

    return wrapPacket(body);
}

// ── compact codec ─────────────────────────────────────────────────────────

function findSub(subs: Subpacket[], type: number): Uint8Array | null {
    const hit = subs.find(s => s.type === type);
    return hit ? hit.data : null;
}

/** Signer fingerprint carried by the packet itself, if it declares one. */
export function signerFingerprint(packetBytes: Uint8Array): string | null {
    try {
        const sig = parseSignature(packetBytes);
        const fpr = findSub(sig.hashed, SUBPKT_ISSUER_FPR) ?? findSub(sig.unhashed, SUBPKT_ISSUER_FPR);
        if (fpr && fpr.length === 21) return hex(fpr.subarray(1));
        return null;
    } catch {
        return null;
    }
}

/** 16-hex key id carried by the packet, if any. */
export function signerKeyId(packetBytes: Uint8Array): string | null {
    try {
        const sig = parseSignature(packetBytes);
        const fpr = signerFingerprint(packetBytes);
        if (fpr) return fpr.slice(-16);
        const kid = findSub(sig.unhashed, SUBPKT_ISSUER_KEYID) ?? findSub(sig.hashed, SUBPKT_ISSUER_KEYID);
        return kid && kid.length === 8 ? hex(kid) : null;
    } catch {
        return null;
    }
}

/**
 * Squeeze a GnuPG Ed25519 detached signature into 72 bytes.
 * Returns null when the packet is not in the exact layout compact mode knows
 * how to rebuild.
 */
export function compress(packetBytes: Uint8Array): Uint8Array | null {
    let sig: SignaturePacket;
    try {
        sig = parseSignature(packetBytes);
    } catch {
        return null;
    }

    if (sig.sigType !== SIGTYPE_BINARY || sig.pubAlgo !== ALGO_EDDSA) return null;
    if (sig.hashed.length !== 2 || sig.unhashed.length !== 1) return null;

    const fpr = findSub(sig.hashed, SUBPKT_ISSUER_FPR);
    const created = findSub(sig.hashed, SUBPKT_CREATED);
    const keyId = findSub(sig.unhashed, SUBPKT_ISSUER_KEYID);
    if (!fpr || fpr.length !== 21 || fpr[0] !== 4) return null;
    if (!created || created.length !== 4) return null;
    if (!keyId || keyId.length !== 8) return null;
    if (!eq(keyId, fpr.subarray(13))) return null;

    if (sig.mpis.length !== 2) return null;
    const [r, s] = sig.mpis;
    if (r.length > 32 || s.length > 32) return null;

    const out = new Uint8Array(COMPACT_LEN);
    out[0] = COMPACT_TAG;
    out[1] = sig.hashAlgo;
    out.set(created, 2);
    out.set(sig.digestPrefix.subarray(0, 2), 6);
    out.set(r, 8 + (32 - r.length));
    out.set(s, 40 + (32 - s.length));

    // Only claim compressibility if we can rebuild the original byte for byte.
    const rebuilt = inflate(out, hex(fpr.subarray(1)));
    return eq(rebuilt, packetBytes) ? out : null;
}

/** Rebuild a full signature packet from a compact blob plus the signer's fpr. */
export function inflate(compact: Uint8Array, signerFpr: string): Uint8Array {
    if (!isCompact(compact)) throw new Error("dsig: not a compact signature blob");
    const fprBytes = unhex(signerFpr);
    if (fprBytes.length !== 20) throw new Error("dsig: signer fingerprint must be 20 bytes");

    const issuerFpr = new Uint8Array(21);
    issuerFpr[0] = 4;
    issuerFpr.set(fprBytes, 1);

    const stripLeadingZeros = (a: Uint8Array) => {
        let i = 0;
        while (i < a.length - 1 && a[i] === 0) i++;
        return a.subarray(i);
    };

    return serializeSignature({
        version: 4,
        sigType: SIGTYPE_BINARY,
        pubAlgo: ALGO_EDDSA,
        hashAlgo: compact[1],
        hashed: [
            { type: SUBPKT_ISSUER_FPR, data: issuerFpr },
            { type: SUBPKT_CREATED, data: compact.subarray(2, 6) }
        ],
        unhashed: [{ type: SUBPKT_ISSUER_KEYID, data: fprBytes.subarray(12) }],
        digestPrefix: compact.subarray(6, 8),
        mpis: [
            stripLeadingZeros(compact.subarray(8, 40)),
            stripLeadingZeros(compact.subarray(40, 72))
        ]
    });
}

/** Convenience: does this packet survive compress → inflate unchanged? */
export function roundTrips(packetBytes: Uint8Array): boolean {
    return compress(packetBytes) !== null;
}

/** Signature creation time (unix seconds) from either representation. */
export function signatureCreated(blob: Uint8Array): number | null {
    if (isCompact(blob)) return new DataView(blob.buffer, blob.byteOffset).getUint32(2);
    try {
        const created = findSub(parseSignature(blob).hashed, SUBPKT_CREATED);
        return created && created.length === 4
            ? new DataView(created.buffer, created.byteOffset).getUint32(0)
            : null;
    } catch {
        return null;
    }
}

// ── ASCII armor ───────────────────────────────────────────────────────────

const CRC24_INIT = 0xb704ce;
const CRC24_POLY = 0x1864cfb;

function crc24(bytes: Uint8Array): number {
    let crc = CRC24_INIT;
    for (const b of bytes) {
        crc ^= b << 16;
        for (let i = 0; i < 8; i++) {
            crc <<= 1;
            if (crc & 0x1000000) crc ^= CRC24_POLY;
        }
    }
    return crc & 0xffffff;
}

/**
 * Wrap raw packet bytes in a standard ASCII-armored detached signature, so a
 * message can be checked with plain `gpg --verify` outside the plugin.
 */
export function armor(packetBytes: Uint8Array, toBase64: (b: Uint8Array) => string): string {
    const b64 = toBase64(packetBytes);
    const lines = b64.match(/.{1,64}/g) ?? [];
    const crc = crc24(packetBytes);
    const crcBytes = Uint8Array.from([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]);
    return [
        "-----BEGIN PGP SIGNATURE-----",
        "",
        ...lines,
        "=" + toBase64(crcBytes),
        "-----END PGP SIGNATURE-----"
    ].join("\n");
}

/** Pull packet bytes back out of an armored block. */
export function dearmor(armored: string, fromBase64: (s: string) => Uint8Array): Uint8Array {
    const body = armored
        .replace(/-----BEGIN[^\n]*-----/, "")
        .replace(/-----END[^\n]*-----/, "")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.includes(":") && !l.startsWith("="))
        .join("");
    return fromBase64(body);
}
