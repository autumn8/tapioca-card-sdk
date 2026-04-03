# tapioca-card-sdk

Transport-agnostic TypeScript SDK for the **TapiocaApplet** JavaCard hardware wallet.

Handles the full card protocol — APDU construction, AES-128-CBC + HMAC-SHA1 secure channel, SLIP-0010 Ed25519 key operations — without any dependency on NFC, PC/SC, or Node.js built-ins. The same SDK runs in React Native, Node.js, and browsers.

---

## Architecture

```
Your app
  └── TapiocaCard            high-level wallet API
        ├── SecureChannel   ECDH handshake + AES/HMAC crypto
        └── CardTransport   ← you implement this (1 method)
              ├── PcscTransport   (Node.js / desktop)
              ├── NfcTransport    (React Native — see tapioca-card-react-native)
              └── WebNfcTransport (browser WebNFC API)
```

You provide a `CardTransport` that knows how to send raw bytes to the card. The SDK does everything else.

---

## Installation

```bash
npm install tapioca-card-sdk
```

The SDK has no peer dependencies and no native bindings. All cryptography is pure JavaScript via [`@noble/curves`](https://github.com/paulmillr/noble-curves), [`@noble/hashes`](https://github.com/paulmillr/noble-hashes), and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers).

---

## Quick Start

### Node.js (PC/SC)

```ts
import { TapiocsCard, CardTransport } from 'tapioca-card-sdk';

// Implement CardTransport for your platform
class PcscTransport implements CardTransport {
  async transmit(command: Uint8Array): Promise<Uint8Array> {
    // send via pcsclite, return full response including SW1 SW2
  }
}

const card = new TapiocaCard(new PcscTransport());
await card.select();

const status = await card.getStatus();
if (!status.setupDone) {
  await card.setup(pin, puk);
}

await card.verifyPin(pin);
const pubkey = await card.importSeed(seed64); // ~2.7s on J3R180
const sig = await card.signTransaction(message); // ~4.2s on J3R180
```

See [`examples/pcsc-sign.ts`](examples/pcsc-sign.ts) for a complete working Node.js example with airdrop and devnet broadcast.

---

## CardTransport Interface

```ts
interface CardTransport {
  transmit(command: Uint8Array): Promise<Uint8Array>;
}
```

`transmit` receives a fully-formed APDU command and must return the full card response including the trailing 2-byte status word (SW1 SW2). The implementation is responsible for transport framing (ISO 14443-4 chaining, T=1 framing, etc.).

---

## API Reference

### `TapiocaCard`

The main entry point. Construct with any `CardTransport`.

```ts
const card = new TapiocaCard(transport);
```

#### Session Management

| Method     | Description                                                                            |
| ---------- | -------------------------------------------------------------------------------------- |
| `select()` | SELECT the TapiocaApplet by AID. Call after every card tap. Resets the secure channel. |

#### Status

| Method        | Returns      | Description                                  |
| ------------- | ------------ | -------------------------------------------- |
| `getStatus()` | `CardStatus` | Read card state. No authentication required. |

`CardStatus` fields:

```ts
{
  protocolMajor, protocolMinor: number  // wire protocol version
  appletMajor, appletMinor: number      // applet firmware version
  pinTriesLeft, pinTriesMax: number
  pukTriesLeft, pukTriesMax: number
  isSeeded: boolean       // seed has been imported
  secureChannelActive: boolean
  setupDone: boolean      // first-time setup has been run
}
```

#### Setup (first-time)

```ts
await card.setup(pin: Uint8Array, puk: Uint8Array): Promise<void>
```

Sets the PIN (4–16 bytes) and PUK (4–16 bytes). Can only be called once — throws `SW_SETUP_ALREADY_DONE` (0x9C03) if already done.

#### PIN Management

| Method                      | Description                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- |
| `verifyPin(pin)`            | Authenticate for the current session. Required before any protected command. |
| `changePin(oldPin, newPin)` | Change PIN. Requires PIN verified.                                           |
| `unblockPin(puk, newPin)`   | Unblock a locked PIN using the PUK.                                          |

Wrong PIN throws `CardError` with `triesRemaining` set:

```ts
try {
  await card.verifyPin(pin);
} catch (err) {
  if (err instanceof CardError) {
    console.log(`${err.triesRemaining} attempts left`);
  }
}
```

#### Seed & Keys

| Method                | Returns                       | Notes                                        |
| --------------------- | ----------------------------- | -------------------------------------------- |
| `importSeed(seed64)`  | `Uint8Array` (32-byte pubkey) | Import 64-byte BIP-39 seed. ~2.7s on J3R180. |
| `resetSeed()`         | —                             | Wipe seed and key material.                  |
| `getPublicKey(path?)` | `Uint8Array` (32 bytes)       | Ed25519 pubkey at derivation path. ~2.7s.    |

`path` defaults to `SOLANA_PATH` (`m/44'/501'/0'`). Pass a custom `readonly number[]` of hardened indexes for other paths.

#### Transaction Signing

```ts
const signature = await card.signTransaction(
  message: Uint8Array,   // output of transaction.serializeMessage()
  path?: readonly number[] // defaults to m/44'/501'/0'
): Promise<Uint8Array>   // 64-byte Ed25519 signature
```

Blind signing — the card signs the raw message bytes. Automatically handles multi-chunk streaming for messages > ~187 bytes. Max message size is 1,200 bytes. Total time ~4.2s on J3R180 (2.7s derivation + 1.4s signing).

Chunk P1 flags used internally:

| Flag           | Value  | Meaning                              |
| -------------- | ------ | ------------------------------------ |
| `FIRST_LAST`   | `0x81` | Single chunk (fits in one APDU)      |
| `FIRST`        | `0x01` | First chunk of multi-chunk message   |
| `CONTINUATION` | `0x00` | Middle chunk                         |
| `LAST`         | `0x80` | Final chunk — card returns signature |

#### Card Label

| Method            | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `getLabel()`      | Read label string. No auth required.                     |
| `setLabel(label)` | Write label (max 64 bytes UTF-8). Requires PIN verified. |

#### Authentikey & Secure Channel

| Method                           | Description                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `exportAuthentikey()`            | Returns the card's 65-byte persistent SECP256K1 identity key.     |
| `initSecureChannel()`            | ECDH handshake — establishes AES-128-CBC session.                 |
| `sendSecure(ins, p1, p2, data?)` | Send encrypted command, return raw `ApduResponse`.                |
| `sendSecureChecked(...)`         | Like `sendSecure`, throws on non-9000 SW, returns decrypted data. |

The `card.sc` property exposes the underlying `SecureChannel` instance for advanced use.

#### Factory Reset

```ts
await card.resetToFactory(): Promise<void>
```

Wipes PIN, PUK, seed, label, and secure channel state. Requires PIN verified. Returns the card to factory-fresh state (expects SW 0xFF00).

---

### `SecureChannel`

The AES-128-CBC + HMAC-SHA1 secure channel client. Usually accessed through `TapiocaCard`, but can be used directly for low-level control.

#### Protocol Summary

1. Client generates an ephemeral SECP256K1 keypair and sends the uncompressed public key in `INS_INIT_SECURE_CHANNEL` (0x81).
2. Card responds with: `coordX(32) | sig1_der | sig2_der` — the X-coordinate of its own ephemeral public key, plus two ECDSA self-signatures.
3. Client reconstructs the full ephemeral public key by trying both Y parities, performs ECDH, and derives:
   - **Session key**: `HMAC-SHA1(sharedX, "sc_key")[0:16]`
   - **MAC key**: `HMAC-SHA1(sharedX, "sc_mac")`
4. Subsequent sensitive commands are wrapped in `INS_PROCESS_SECURE_CHANNEL` (0x82):
   - Inner APDU is PKCS#7 padded and AES-128-CBC encrypted
   - IV is 12 random bytes + 4-byte big-endian counter (last byte forced odd)
   - Payload: `IV(16) | enc_size(2) | encrypted | mac_size(2) | HMAC-SHA1`

#### `SecureChannel` API

| Method/Property                                           | Description                                           |
| --------------------------------------------------------- | ----------------------------------------------------- |
| `isActive`                                                | `true` after a successful handshake                   |
| `authentikeyBytes`                                        | 65-byte authentikey, set after `exportAuthentikey()`  |
| `reset()`                                                 | Clear session keys and counter                        |
| `exportAuthentikey(transport)`                            | Fetch and cache the card's identity key               |
| `handshake(transport)`                                    | Perform ECDH, return `HandshakeResult`                |
| `send(transport, ins, p1, p2, data?)`                     | Encrypt and send, return `ApduResponse`               |
| `sendChecked(transport, ins, p1, p2, data?, expectedSw?)` | Like `send`, throws on bad SW, returns decrypted data |

---

### `CardError`

Thrown when the card returns an unexpected status word.

```ts
class CardError extends Error {
  readonly sw: number; // e.g. 0x63C3
  readonly triesRemaining?: number; // set for 0x63Cx PIN failures
}
```

---

### Constants

```ts
import {
  APPLET_AID,
  CLA,
  INS,
  SIGN_P1,
  SW,
  SOLANA_PATH,
} from 'tapioca-card-sdk';
```

| Export          | Value                                              | Description                         |
| --------------- | -------------------------------------------------- | ----------------------------------- |
| `APPLET_AID`    | `Uint8Array([0x53,0x6f,0x6c,0x61,0x6e,0x61,0x00])` | "Solana\0"                          |
| `CLA`           | `0xB0`                                             | Command class byte                  |
| `SOLANA_PATH`   | `[0x8000002c, 0x800001f5, 0x80000000]`             | m/44'/501'/0'                       |
| `SW.OK`         | `0x9000`                                           | Success                             |
| `SW.PIN_FAILED` | `0x63C0`                                           | OR-in tries remaining in low nibble |

---

## Status Words

| SW       | Constant                | Meaning                       |
| -------- | ----------------------- | ----------------------------- |
| `0x9000` | `SW.OK`                 | Success                       |
| `0xFF00` | `SW.RESET_TO_FACTORY`   | Factory reset complete        |
| `0x63Cx` | `SW.PIN_FAILED`         | Wrong PIN/PUK, x = tries left |
| `0x9C03` | `SW.SETUP_ALREADY_DONE` | setup() called twice          |
| `0x9C04` | `SW.SETUP_NOT_DONE`     | Command requires setup first  |
| `0x9C06` | `SW.UNAUTHORIZED`       | PIN not verified this session |
| `0x9C0C` | `SW.IDENTITY_BLOCKED`   | PIN + PUK both exhausted      |
| `0x9C14` | `SW.SEED_NOT_IMPORTED`  | importSeed() required         |
| `0x9C21` | `SW.SC_UNINITIALIZED`   | Secure channel not set up     |
| `0x9C22` | `SW.SC_REQUIRED`        | Command needs secure channel  |
| `0x9C23` | `SW.SC_WRONG_MAC`       | MAC verification failed       |
| `0x9C24` | `SW.SC_WRONG_IV`        | IV invalid or replayed        |

Diagnostic codes from on-card exception handlers (useful during development):

| SW range        | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `0x9C50–0x9C5F` | `CryptoException` during SC decrypt (reason in low nibble) |
| `0x9C70–0x9C7F` | `CryptoException` during command dispatch                  |
| `0x9C60`        | `ArrayIndexOutOfBoundsException` in SC decrypt             |
| `0x9C80`        | `ArrayIndexOutOfBoundsException` in command dispatch       |

---

## Testing

```bash
npm test
```

Tests use [Vitest](https://vitest.dev/) with a mock `CardTransport`. No card hardware or NFC required.

Test files are in `src/__tests__/`:

| File                     | What it covers                                                              |
| ------------------------ | --------------------------------------------------------------------------- |
| `apdu.test.ts`           | `buildApdu`, `parseResponse`, `sendApdu`, `sendApduChecked`, `selectApplet` |
| `types.test.ts`          | `CardError` construction and `triesRemaining` extraction                    |
| `secure-channel.test.ts` | `SecureChannel` state machine, AES/HMAC round-trip crypto, IV counter       |
| `tapioca-card.test.ts`   | `TapiocaCard` method dispatch, data formatting, chunking logic              |
| `constants.test.ts`      | AID encoding, path values, flag bitmasks                                    |

```bash
npm run check    # TypeScript type-check only (no emit)
npm run build    # Compile to dist/
```

---

## Hardware Notes

Tested on **NXP JCOP4 J3R180** (ISO 14443-4 Type A, JavaCard 3.0.5).

| Operation                          | Time on J3R180 |
| ---------------------------------- | -------------- |
| SELECT + GET_STATUS                | ~50ms          |
| Secure channel handshake           | ~300ms         |
| VERIFY_PIN                         | ~200ms         |
| Import seed (SLIP-0010 derivation) | ~2,700ms       |
| Get public key                     | ~2,700ms       |
| Sign transaction                   | ~4,200ms       |

The slow operations are HMAC-SHA512 iterations in SLIP-0010 key derivation running on the card's hardware crypto engine.

---

## License

AGPL-3.0
