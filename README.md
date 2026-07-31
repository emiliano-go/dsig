# dsig: GPG message signing for Vencord / Vesktop

Every message you send carries a compact, verifiable attestation that **this account**, in
**this channel**, at **this moment**, wrote **this exact text**, signed by your own GPG key.
Signatures regenerate on edit. Incoming messages from keys you have pinned get a badge.

> **This is not encryption.** Your messages travel in plaintext exactly as they always did.
> Anyone can read them. What is protected is *authorship*: nobody can put words in your mouth,
> and nobody can quietly alter yours.

---

## Contents

- [What it looks like](#what-it-looks-like)
- [Requirements](#requirements)
- [Step 1: Set up a signing key](#step-1-set-up-a-signing-key)
- [Step 2: Install](#step-2-install)
- [Step 3: Configure in the app](#step-3-configure-in-the-app)
- [Step 4: Pin your peers](#step-4-pin-your-peers)
- [Passphrase prompts and gpg-agent](#passphrase-prompts-and-gpg-agent)
- [Settings reference](#settings-reference)
- [Footer style](#footer-style)
- [Badges](#badges)
- [Wire format](#wire-format)
- [Security notes](#security-notes)
- [Threat model](#threat-model)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Known limitations](#known-limitations)

---

## What it looks like

**For people running the plugin**, the footer is hidden and replaced by a badge next to your
name:

```
Emiliano  🛡 SIGNED   today at 14:32
hello there
```

Hovering the badge shows the signer's fingerprint, the label you gave that peer, and how far the
signed time sits from Discord's own timestamp.

When several of your messages collapse under one name, the badge counts them, and says so
when part of the run is not signed:

```
Emiliano  🛡 SIGNED ×7   today at 14:32
Emiliano  🛡 SIGNED ×8 · 2 UNSIGNED
```

**For everyone else** (the vast majority of people you talk to) the message arrives as ordinary
text with the footer attached. How intrusive that is, is a setting; see
[footer style](#footer-style):

```
hello there
-# ‖dsig:1:ms94qyh0:AQpqbMbXlgzekW1hYzqKl+eFTnM0mUbZnCmYy1mna/ChXn9iCbJg1NbU9wCj1KsrsfCGFsn9Q0OUAFJa1HcLTRmPx4n8OR8O
```

The same exchange, ASCII-only, as each side sees it (`[SIGNED]` is the badge; `|` stands in
for the `‖` mark):

```text
Alice sends "hello there" signed.

Alice, with the plugin:               Bob, with the plugin:
  [12:34] Alice  [SIGNED]               [12:34] Alice  [SIGNED]
  hello there                           hello there

Bob, without the plugin (desktop, mobile, web, bots all look the same):
  [12:34] Alice
  hello there
  |-# |dsig:1:ms94qyh0:AQpqbMbXlgzekW1hYzqKl+eFTnM0mUbZnCmYy1mna/ChXn9iCbJg1NbU9wCj1KsrsfCGFsn9Q0OUAFJa1HcLTRmPx4n8OR8O
```

That is 113 characters on its own line (116 with the `-# ` subtext marker). It contains no
markdown-significant characters, so every client (desktop, mobile, web, bots) renders it
literally rather than mangling it. It is inert: it does not ping anyone, does not embed, and
does not affect replies or search.

It is still visible clutter, and that is the real cost of this plugin. Consider
`signChannels: "DMs only"` or the allowlist if you don't want to inflict it on busy servers.

---

## Requirements

| | |
|---|---|
| **Vesktop** or **Discord Desktop** | the `gpg` backend needs a main process to shell out from |
| **GnuPG 2.x** | `gpg --version`; tested against 2.4.9 |
| **Node + pnpm** | to build Vencord from source, which is what userplugins require |
| **A GPG key you control** | see below |

Web Discord can only use the openpgp.js backend; see
[Known limitations](#known-limitations).

---

## Step 1: Set up a signing key

### Recommended: an Ed25519 signing subkey on your existing key

Ed25519 is the recommended key type, for a concrete reason: only Ed25519 signatures fit dsig's
**compact** format (113-character footer). Everything else falls back to the full OpenPGP packet
(177 characters); it works identically, it is just 64 more characters of clutter in every
message.

If you already have a GPG key, don't replace it. Add a signing subkey to it, so you keep your
identity, your uid and any signatures others have made on your key:

```sh
gpg --quick-add-key <your-key-fingerprint> ed25519 sign never
```

`never` means the subkey does not expire; use e.g. `2y` if you would rather rotate it.

Then find the new subkey's fingerprint; it is the one marked `[S]`:

```sh
gpg --list-keys --with-subkey-fingerprints <your-key-fingerprint>
```

```
pub   rsa4096 2026-02-07 [SC]
      F759D6D49B0A395AB922414A5CC3B4C50D37E793
uid           [ultimate] Your Name <you@example.com>
sub   rsa4096 2026-02-07 [E]
      46DAFA19359454B41D262D478CBD911D96D107DC
sub   ed25519 2026-07-31 [S]          ← this one
      169051AA38444701DDD8E79E533B2AC87A8A0869
```

Using a *subkey* rather than your primary key is good hygiene independent of this plugin: the
subkey is what does day-to-day work and can be revoked and replaced on its own, while the primary
key (the thing that actually is your identity) stays untouched.

### No key yet?

```sh
gpg --quick-gen-key "Your Name <you@example.com>" ed25519 sign never
```

### Back it up first

Adding a subkey rewrites your private keyring. Before you touch a long-lived key:

```sh
( umask 077; gpg --export-secret-keys --armor <fingerprint> > ~/gpg-secret-backup-$(date +%F).asc )
( umask 077; gpg --export-ownertrust > ~/gpg-ownertrust-$(date +%F).txt )
( umask 077; gpg --output ~/gpg-revoke-$(date +%F).asc --gen-revoke <fingerprint> )
```

The `umask 077` subshell keeps the secret key from ever being world-readable in your home
directory. The revocation certificate must be generated while the key still works; it is the
only way to kill the key if you lose the passphrase. Store it separately from the secret key and
move all three off the machine.

---

## Step 2: Install

Userplugins are not distributed as files you drop into a running client; they are compiled into
Vencord. So you build Vencord yourself, once.

```sh
git clone https://github.com/Vendicated/Vencord.git ~/Documents/GitHub/Vencord
cd ~/Documents/GitHub/Vencord
pnpm install
```

Then, from this repo:

```sh
./install.sh ~/Documents/GitHub/Vencord
```

That copies `plugin/` into `Vencord/src/userplugins/dsig` and rebuilds. (It copies rather than
symlinks: esbuild resolves real paths, so a symlink pointing outside the tree breaks Vencord's
`@api/…` aliases.) The path argument defaults to `~/Documents/GitHub/Vencord`.

### Point your client at the build

**Vesktop**: do **not** run `pnpm inject`. Vesktop loads Vencord from its own setting:

> Vesktop → Settings → **Vencord Location** → select `~/Documents/GitHub/Vencord/dist`

or, with Vesktop closed, in `~/.config/vesktop/state.json`:

```json
{ "vencordDir": "/home/you/Documents/GitHub/Vencord/dist" }
```

Vesktop validates that directory by looking for `package.json` plus `vencordDesktopMain.js`,
`vencordDesktopPreload.js`, `vencordDesktopRenderer.js` and `vencordDesktopRenderer.css`.
`install.sh` creates the `package.json` if it is missing. Note that this **disables Vesktop's
automatic Vencord updates**; you now update Vencord yourself, see [Updating](#updating).

**Discord Desktop**: the standard route applies:

```sh
cd ~/Documents/GitHub/Vencord && pnpm inject
```

Restart the client either way.

---

## Step 3: Configure in the app

1. **Settings → Plugins → Dsig**: enable it. It depends on `MessageEventsAPI` and
   `MessageDecorationsAPI`; both are on by default.
2. Open its **cog**.
3. **Signing key**: pick the `[S]` Ed25519 subkey. Non-Ed25519 keys appear too, labelled
   *(armored only)*. The plugin stores the fingerprint with a trailing `!`, which forces gpg to
   use that exact subkey instead of choosing one itself.
4. **Sign & verify** (diagnostics, at the bottom): press it. This runs the entire pipeline
   (canonicalise → payload → sign → compact → footer → parse → inflate → verify → negative
   control) against your real key without involving Discord, and reports sizes and timings. If
   this fails, nothing else will work, and the error tells you why.

**On web, or if you prefer it on desktop:** set *Crypto backend* to **openpgp.js** and the key
picker becomes an import box. Tick the acknowledgement (the private key is stored in the
browser's IndexedDB, where any other plugin can read it), paste an **unencrypted** armored
private key, and press *Import private key*. (Passphrase-protected keys are rejected; import a
decrypted copy.) The stored key can be wiped again with the *Remove stored key* button in the
same panel. Do not import a long-lived key this way.

Until a signing key is selected the plugin stays inert; it will not send anything, signed or
otherwise, that it cannot stand behind.

---

## Step 4: Pin your peers

dsig verifies against keys you have **pinned by hand**, like SSH's `known_hosts`. It never trusts
a key just because it arrived in a message, and there is no key server lookup. That is the whole
security model: you decide whose keys count.

**Pin your own key first.** Otherwise your own messages badge as *unknown signer*, because the
plugin has nothing to check them against. There is a button for this:

> Trusted peer keys → **Pin my own key**

It exports the public half of your signing key, reads your Discord user ID from the client, and
pins the two together. No copying, no typing.

To hand your key to someone else:

```sh
gpg --armor --export <your-key-fingerprint>
```

**For each peer:** paste their armored public key into **Add peer**, label it, and add their
Discord user ID (enable **Developer Mode** in Discord's Advanced settings, then right-click the
user and *Copy User ID*).

Note that `gpg --export` always emits the **whole** key, so a peer is pinned under its *primary*
fingerprint while its signatures name a *signing subkey*. dsig records every signing-capable
fingerprint in the blob and matches against all of them, so both forms of key work; the badge
always names the subkey that actually signed.

> **Confirm the fingerprint out of band** (voice call, in person, a signed post somewhere else)
> *before* you pin it. A key handed to you over the same Discord channel you are trying to secure
> proves nothing.

### Why the Discord user ID matters

Without it, a valid badge only claims *"a key you pinned signed this"*. With it, the badge claims
*"**this account's** key signed this"*, and a message from a different account signed with that
key is downgraded to *unknown signer*. That second claim is the one you actually want. Fill it
in.

---

## Passphrase prompts and gpg-agent

Signing happens on every message you send. The private key never leaves `gpg-agent`, but that
means every send needs the agent to have your passphrase cached. When the cache expires, the next
message pops a pinentry dialog and the send waits for it.

By default gpg-agent caches for 10 minutes of inactivity, 2 hours maximum. For a chat client that
is short. In `~/.gnupg/gpg-agent.conf`:

```
default-cache-ttl 28800    # 8 hours idle
max-cache-ttl 86400        # 24 hours absolute
```

```sh
gpgconf --reload gpg-agent
```

Pick numbers you are comfortable with: a longer cache means less typing and a longer window in
which someone with access to your unlocked session can sign as you. `default-cache-ttl` resets on
each use; `max-cache-ttl` is a hard ceiling from when the passphrase was entered.

A first signature after the agent starts takes a few seconds (agent startup plus your typing);
cached signatures take tens of milliseconds. Verification never needs the agent at all.

---

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| **Sign my outgoing messages** | on | master switch for the signing half |
| **Signing key** | none | Ed25519 `[S]` subkey recommended; stored with a trailing `!` |
| **Footer style** | Small grey line | how the footer looks to people without the plugin, see [footer style](#footer-style) |
| **Signature format** | Compact | Compact = 113-char footer, plugin-only. Armored = 177 chars, verifiable by plain `gpg --verify` |
| **Where to sign** | Everywhere | or *DMs only*, or an allowlist |
| **Allowlisted channel IDs** | none | comma-separated, used in allowlist mode |
| **Verify incoming messages** | on | |
| **Trusted peer keys** | none | the pinned-peer manager |
| **Show 'unknown signer' badge** | on | off = unpinned signatures show no badge at all |
| **Clock tolerance** | 10 s | how far the signed time may sit from Discord's timestamp |
| **When the signed time exceeds tolerance** | warn | *warn* keeps it valid with a warning badge; *fail* treats it as invalid |
| **Crypto backend** | System gpg | openpgp.js is the web fallback |
| **Path to the gpg binary** | `gpg` | absolute path if it isn't on `PATH` |
| **Hide the raw signature footer** | on | display-only; the real content is untouched. Needs a restart |
| **Badge style** | Pill with label | or icon only |
| **Sign & verify** | – | diagnostic self-test of the full pipeline, see [Step 3](#step-3-configure-in-the-app) |

Peer keys and the verify cache live in IndexedDB, not in the settings JSON: they are data, not
config, and they do not sync.

---

## Footer style

The footer has to travel in the message text, so everyone without the plugin sees *something*.
Three shapes are available; all three are accepted on the way in, so peers can each pick their
own.

| Style | What a non-plugin reader sees | Cost |
|---|---|---|
| **Small grey line** (default) | the footer as Discord subtext: small, grey, one line | none |
| **Plain line of text** | a full-size line of base64 | loud |
| **Invisible** | nothing; the footer is encoded in codepoints that draw nothing and is appended to the message | ~25% more characters against the 2000-character limit; a client that does not support variation selectors may draw boxes |

The invisible style encodes one byte per invisible codepoint (`U+FE00`–`U+FE0F` and
`U+E0100`–`U+E01EF`, marked by `U+2062`). Copying such a message copies the hidden run with it,
and anyone pasting it into a hex editor can see it is there; it is *unobtrusive*, not secret.

---

## Badges

| Badge | Colour | Meaning |
|---|---|---|
| **signed** | green | the signature covers this author, this channel, this time and this exact text |
| **signed ×N** | green | a collapsed run of N messages, all signed. `signed ×8 · 2 unsigned` means two messages in the run carry no signature |
| **signed · time mismatch** | amber | cryptographically fine, but the signed time is far from Discord's timestamp |
| **signature invalid** | red | content, author, channel or message id do not match the signature |
| **unknown signer** | grey | signed by a key you have not pinned, or one not pinned to this account |
| **signing…** | grey | the message has no snowflake yet; a moment on your own messages as they send |
| **signature error** | grey | the backend failed before a verdict: gpg unreachable, import error, etc. |
| *(none)* | n/a | unsigned message |

Clock skew and integrity failure are deliberately different colours. A red ✗ that fires because
someone's clock drifted is a red ✗ nobody believes; keeping the two apart is what makes the red
one mean something.

A badge sits next to the name, and Discord draws the name once per group. So the badge on a
collapsed run answers for the whole run: every message in it is verified, and the counts above
are what comes out. A group ends at a new author, a reply, or seven minutes of silence. (In
Discord's compact mode every message gets its own row, so badges are per-message there.)

**"signature invalid" does not necessarily mean forgery.** The far more common cause is an edit
made from a client without the plugin: the old footer stays attached to new text, so the
signature no longer matches. Which is exactly what it should say.

---

## Wire format

The signed payload is rebuilt from scratch on the verifying side (never parsed out of the
message) from the live author, channel, message id and content, plus the timestamp in the
footer. Content comes last, so it can never shift a field:

```
original: dsig-v1\no\n{author_id}\n{channel_id}\n{signed_ts_ms}\n{content}
edited:   dsig-v1\ne\n{author_id}\n{channel_id}\n{message_id}\n{signed_ts_ms}\n{content}
```

Only what cannot be recovered from the message itself travels:

```
‖dsig:1:{base36 signed_ts_ms}:{base64 signature blob}
```

That line is what goes on the wire in the *plain* and *small grey line* styles (the latter
prefixes it with Discord's `-# ` subtext marker). The *invisible* style carries the same two
fields as `U+2062` followed by one invisible codepoint per byte of
`[version][6-byte signed_ts_ms][signature blob]`. All three are parsed on the way in regardless
of which one you send; a message carries exactly one, and the last one wins.

The blob is either a compact 72-byte form or a full OpenPGP signature packet; the first byte
distinguishes them. Compact keeps `[tag][hash algo][created][digest prefix][r][s]` and rebuilds
the rest from the verifier's copy of the signer's fingerprint. Compact is only used when the
signature provably survives compress → inflate byte for byte, checked at signing time, so an
unusual gpg build can never emit footers nobody can verify; it silently uses the full packet
instead.

To check an *armored* footer by hand: strip the footer line, rebuild the payload exactly as
above from the live author, channel, message id and content plus the footer's timestamp,
base64-decode the blob into a file, and run `gpg --verify <sig> <payload>`. Compact footers
cannot be checked this way; the signer's fingerprint is not on the wire.

**Content canonicalisation** is the single largest source of false ✗ in a scheme like this. Both
sides call the same function: NFC, CRLF→LF, per-line trailing whitespace removed, whole message
trimmed. It is idempotent and a fixed point of Discord's own trimming, which is what makes a
round-tripped message hash identically on both ends.

Timestamps are cross-checked against the Discord snowflake, which the sender does not control.
That bounds replay and backdating without needing a trusted timestamp authority.

---

## Security notes

- **Key custody.** The gpg backend never lets the secret leave `gpg-agent`; the renderer only
  ever sees payloads and signatures. The openpgp.js backend stores the private key in IndexedDB
  where any other plugin can read it, and is gated behind an explicit acknowledgement.
- **No shell, ever.** gpg is spawned with argv arrays. Payloads go via stdin; signatures and peer
  keys via `0600` files in a fresh `mkdtemp` directory, removed in `finally`.
- **Verdicts come from `--status-fd`**, not exit codes. `EXPKEYSIG` and `REVKEYSIG` are *not*
  good signatures here, even though the maths checks out.
- **Verification is isolated.** A peer's key is imported into a throwaway `GNUPGHOME`, so a
  verdict can never be satisfied by some unrelated key in your real keyring, and inspecting a
  peer key never mutates your keyring.
- **Your messages stay public.** Signing is not encryption. Do not let a green badge talk you
  into saying things you would not say in plaintext.
- **ToS.** Client mods violate Discord's terms of service. Bans are rare but possible.

---

## Threat model

| Threat | Mitigated | How |
|---|---|---|
| Someone copies your text and reposts it as their own | ✅ | `author_id` is signed and checked against the live author |
| A signature is lifted into another channel | ✅ | `channel_id` is signed |
| An old signature is replayed on a new message | ✅ | `signed_ts_ms` is signed and cross-checked against the snowflake |
| Content edited without re-signing | ✅ | verify recomputes over the live content |
| Someone edits from a client without the plugin | ✅ | old footer over new text → ✗ (or the footer is gone → unsigned) |
| A key you pinned is used from another account | ✅ | per-peer `discordUserIds` binding, if you filled it in |
| You backdate your own clock | ⚠️ | bounded by the snowflake tolerance; not a trusted timestamp |
| Discord itself is compromised or MITMs you | ❌ | out of scope, as for all client-mod crypto |
| A malicious plugin logs your keystrokes | ❌ | out of scope; audit your plugins |

---

## Updating

After editing anything under `plugin/`:

```sh
./install.sh ~/Documents/GitHub/Vencord   # copies + rebuilds
```

and restart the client.

Because Vesktop's *Vencord Location* now points at your own build, Vesktop no longer updates
Vencord for you. To take upstream Vencord changes:

```sh
cd ~/Documents/GitHub/Vencord && git pull && pnpm install
cd - && ./install.sh
```

To go back to stock Vencord, clear *Vencord Location* in Vesktop's settings (or delete
`vencordDir` from `~/.config/vesktop/state.json`) and restart; Vesktop will re-download the
official build, and the plugin disappears with it.

---

## Troubleshooting

**The Dsig cog says gpg is not usable.** Set the absolute path in *Path to the gpg binary*
(`which gpg`). Electron apps often have a narrower `PATH` than your shell.

**Everything I send badges as *unknown signer*.** You have not pinned your own public key, or you
pinned it without your Discord user ID. See [Step 4](#step-4-pin-your-peers).

**All my footers are 177 characters, not 113.** You are signing with a non-Ed25519 key. Add an
Ed25519 signing subkey and re-select it in the key picker.

**A pinentry dialog appears whenever I send a message.** Expected when the agent's cache expires
; see [gpg-agent](#passphrase-prompts-and-gpg-agent).

**A message I know is fine shows *signature invalid*.** Almost always an edit made from another
client, which leaves the old footer over new text. Also check that both sides run the same plugin
version: the canonicalisation rules are part of the wire format.

**Messages show *time mismatch*.** Your clock or theirs is off from real time by more than the
tolerance. Fix the clock (`timedatectl` / NTP) rather than raising the slider: the check is what
bounds signature replay.

**The footer shows up in the edit box.** The plugin strips it when you start editing, so you
edit your own text and the message is re-signed on save. If it still appears, Discord's
dispatcher no longer accepts the interceptor (check the console); editing still works, just
delete the footer line yourself; anything left at the end is dropped before signing anyway.

**The footer is visible even though *hide footer* is on.** The render patch stopped matching
after a Discord update. Signing and verification are unaffected; the footer is cosmetic. Check
the console for a Vencord patch warning.

**Discord loads with no Vencord at all after a rebuild.** Something in the plugin evaluated JSX
at module scope. Vencord compiles JSX to `VencordCreateElement`, which resolves to
`Vencord.Webpack.Common.React.createElement` on first call; that global is assigned by the
bundle's own IIFE, so JSX evaluated during import throws `Cannot read properties of undefined
(reading 'Webpack')` and the whole bundle dies with it. Keep every element behind a function that
runs at render time. To see the error at all, launch with `vesktop --enable-logging=stderr`; it
never reaches the terminal otherwise.

**A toast says "message sent UNSIGNED".** Signing failed: no key selected, gpg unreachable, or
the passphrase prompt was cancelled. The message went out as plain text rather than silently
pretending to be signed. The toast carries the reason.

---

## Development

```
dsig/
├── plugin/          ← this is what goes into Vencord/src/userplugins/dsig
│   ├── index.tsx        plugin entry: hooks, render patch, badge decoration
│   ├── native.ts        main-process gpg bridge (secret never leaves gpg-agent)
│   ├── settings.tsx     definePluginSettings schema
│   ├── sign.ts          pre-send / pre-edit signing
│   ├── verify.ts        verification orchestration + status decisions
│   ├── group.ts         collapsed-run grouping + badge summaries
│   ├── render.ts        render-time footer hiding
│   ├── store.ts         DataStore wrappers (pinned peers, verify cache)
│   ├── types.ts         shared types (renderer and main process)
│   ├── styles.css       badge and settings-panel styles
│   ├── crypto/
│   │   ├── payload.ts   canonical payload + content canonicalisation
│   │   ├── footer.ts    ‖dsig footer codec
│   │   ├── packet.ts    OpenPGP v4 signature parsing, compact codec, armor
│   │   ├── status.ts    gpg --status-fd parsing
│   │   ├── backend.ts   gpg / openpgp.js selection
│   │   └── openpgp.ts   openpgp.js backend (web)
│   └── components/      Badge, KeyPicker, PeerManager, TestPanel
├── tests/           node:test suite
└── install.sh
```

```sh
npm test
```

118 tests, run against the real `gpg` binary in a throwaway keyring under `/tmp`; your own
keyring is never touched, and the gpg-dependent suites skip themselves if gpg is missing. They
cover canonicalisation idempotence, the base64 and footer codecs (all three footer shapes),
byte-identical OpenPGP packet round-trips against real gpg output across SHA-256/384/512, the
native bridge (including argv-injection refusals and `--status-fd` parsing), every verify status
end to end, message-group summarising, and render-time footer stripping.

The suite imports the plugin's own modules through a small resolver hook
(`tests/resolve-hook.mjs`) that fills in extensionless imports and swaps the two modules needing
a bundler (`settings`, `crypto/backend`) for stubs. Everything with real logic is the genuine
module.

Verified against the current Vencord tree: `eslint` clean, `tsc --noEmit` clean, `pnpm build`
produces a bundle containing the plugin and registering its native module.

---

## Known limitations

- **The render patch is unverified against a live Discord client.** Footer hiding attaches to the
  markdown content renderer (the same insertion point FakeNitro uses). If Discord's bundle
  shifts, the patch stops applying and the footer simply becomes visible.
- **The openpgp.js backend is untested.** It loads openpgp.js at runtime from `cdn.jsdelivr.net`
  (on Vencord's CSP allowlist) and cannot be exercised from Node. Web Discord has no main process
  and therefore no access to your gpg keyring, so it is the only option there, at the cost of
  keeping your private key in IndexedDB.
- **Compact mode cannot name an unpinned signer.** A compact signature does not carry the
  signer's fingerprint, so "no pinned key verifies this" is genuinely ambiguous between a wrong
  key and altered content; the badge says so rather than overclaiming. Armored mode names the
  signer.
- **Both parties need the plugin** to see badges. Everyone else sees the footer line.
- **Peers pinned before signing subkeys were tracked** (`signingFingerprints` on the stored
  record) still verify if their key signs with its primary key, but not if it signs with a
  subkey. Re-pin those with **Add peer**; it records the subkeys now.
- **The plugin cannot prove you didn't say something.** An unsigned message is just an unsigned
  message; anyone can send one, including you from your phone.

---

GPL-3.0-or-later, matching Vencord.
