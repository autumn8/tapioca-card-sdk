/**
 * End-to-end tests for TapiocaCard over PC/SC.
 *
 * Prerequisites:
 *   - A TapiocaApplet JavaCard must be connected via a PC/SC reader.
 *   - If the card is already set up, it must be set up with TEST_PIN / TEST_PUK
 *     (or the test will fail at the factory-reset step).
 *
 * Run:
 *   npm run test:e2e
 *
 * The suite factory-resets the card at the start and leaves it clean at the
 * end, so subsequent runs are idempotent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bip39 from 'bip39';
import { ed25519 } from '@noble/curves/ed25519';
import { TapiocaCard, SOLANA_PATH, CardError } from '../src';
import { PcscTransport } from './transport';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TEST_MNEMONIC =
  'always thunder family peasant ancient pioneer nut vote detect monster shaft timber prepare program clump awake unable error garden shield sand fossil orphan clump';
const TEST_PIN = new TextEncoder().encode('1234');
const TEST_PIN_NEW = new TextEncoder().encode('5678');
const TEST_PUK = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x46]); // "ABCDEF"
const TEST_LABEL = 'Tapioca E2E';

// A small synthetic transaction message — no need for a real Solana transaction.
const TEST_MESSAGE = new Uint8Array(50).fill(0x42);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Select applet and open a secure channel in one call. */
async function selectAndOpenChannel(card: TapiocaCard): Promise<void> {
  await card.select();
  await card.initSecureChannel();
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('TapiocaCard E2E (PC/SC)', () => {
  let transport: PcscTransport;
  let card: TapiocaCard;
  let pubkeyBytes: Uint8Array;

  // ── Setup ──────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    transport = await PcscTransport.connect(30_000);
    card = new TapiocaCard(transport);
    await selectAndOpenChannel(card);

    // Ensure we always start from a clean slate.
    // If the card is already set up, attempt a factory reset using the test PIN.
    // If that fails the caller must manually reset the card first.
    const status = await card.getStatus();
    if (status.setupDone) {
      await card.verifyPin(TEST_PIN);
      await card.resetToFactory();
      await selectAndOpenChannel(card);
    }
  }, 120_000);

  afterAll(() => {
    transport?.disconnect();
  });

  // ── 1. Initial state after factory reset ───────────────────────────────────

  it('getStatus: fresh card reports setup not done', async () => {
    const status = await card.getStatus();
    expect(status.setupDone).toBe(false);
    expect(status.isSeeded).toBe(false);
  });

  // ── 2. Setup ───────────────────────────────────────────────────────────────

  it('setup: initialises PIN and PUK', async () => {
    await expect(card.setup(TEST_PIN, TEST_PUK)).resolves.toBeUndefined();
  });

  it('getStatus: setup done after setup()', async () => {
    const status = await card.getStatus();
    expect(status.setupDone).toBe(true);
    expect(status.isSeeded).toBe(false);
  });

  it('setup: second call throws SETUP_ALREADY_DONE (0x9C03)', async () => {
    await expect(card.setup(TEST_PIN, TEST_PUK)).rejects.toMatchObject({
      sw: 0x9c03,
    });
    // Card resets SC state on any non-9000 response; re-init before next command
    await card.initSecureChannel();
  });

  // ── 3. PIN verification ────────────────────────────────────────────────────

  it('verifyPin: each wrong attempt returns correct SW and triesRemaining', async () => {
    const { pinTriesMax } = await card.getStatus();
    const wrongPin = new TextEncoder().encode('0000');

    // Exhaust all but one try, asserting exact SW and parsed triesRemaining.
    // Re-init SC after each failure because the card resets session state on errors.
    for (let expected = pinTriesMax - 1; expected >= 1; expected--) {
      let err: CardError | undefined;
      try {
        await card.verifyPin(wrongPin);
      } catch (e) {
        err = e as CardError;
      }
      expect(err, `attempt leaving ${expected} tries`).toBeInstanceOf(
        CardError
      );
      expect(err!.sw, `SW for ${expected} tries left`).toBe(0x63c0 | expected);
      expect(
        err!.triesRemaining,
        `triesRemaining for ${expected} tries left`
      ).toBe(expected);

      // Cross-check: getStatus must agree with the tries count encoded in SW.
      const status = await card.getStatus();
      expect(
        status.pinTriesLeft,
        `getStatus pinTriesLeft for ${expected} tries left`
      ).toBe(expected);

      await card.initSecureChannel();
    }
  });

  it('verifyPin: correct PIN resets tries and succeeds', async () => {
    await expect(card.verifyPin(TEST_PIN)).resolves.toBeUndefined();
    const { pinTriesLeft, pinTriesMax } = await card.getStatus();
    expect(pinTriesLeft).toBe(pinTriesMax);
  });

  it('verifyPin: last wrong attempt blocks card (0x9C0C)', async () => {
    const { pinTriesMax } = await card.getStatus();
    const wrongPin = new TextEncoder().encode('0000');

    // Drain tries from pinTriesMax down to 1; re-init SC after each error
    for (let i = 0; i < pinTriesMax - 1; i++) {
      const expected = pinTriesMax - 1 - i;
      let err: CardError | undefined;
      try {
        await card.verifyPin(wrongPin);
      } catch (e) {
        err = e as CardError;
      }
      expect(
        err!.triesRemaining,
        `drain: triesRemaining for ${expected} tries left`
      ).toBe(expected);
      const status = await card.getStatus();
      expect(
        status.pinTriesLeft,
        `drain: getStatus pinTriesLeft for ${expected} tries left`
      ).toBe(expected);
      await card.initSecureChannel();
    }

    // One more wrong attempt takes tries to 0 — SW=0x63C0, not yet blocked
    await expect(card.verifyPin(wrongPin)).rejects.toMatchObject({
      sw: 0x63c0,
    });
    const zeroStatus = await card.getStatus();
    expect(
      zeroStatus.pinTriesLeft,
      'getStatus pinTriesLeft after last attempt'
    ).toBe(0);
    await card.initSecureChannel();

    // Now tries=0: card fires IDENTITY_BLOCKED (0x9C0C) without consuming another try
    await expect(card.verifyPin(wrongPin)).rejects.toMatchObject({
      sw: 0x9c0c,
    });
    await card.initSecureChannel();

    // Even the correct PIN is rejected while blocked
    await expect(card.verifyPin(TEST_PIN)).rejects.toMatchObject({
      sw: 0x9c0c,
    });
    await card.initSecureChannel();
  });

  it('unblockPin: PUK unblocks card and restores correct PIN', async () => {
    await expect(card.unblockPin(TEST_PUK, TEST_PIN)).resolves.toBeUndefined();
    await expect(card.verifyPin(TEST_PIN)).resolves.toBeUndefined();
  });

  // ── 4. Seed import ─────────────────────────────────────────────────────────
  // Start a fresh SC session here — the PIN section involves many initSecureChannel()
  // calls and the session state after unblockPin is not guaranteed to be clean.

  it('importSeed: returns 32-byte Ed25519 public key', async () => {
    await selectAndOpenChannel(card);
    await card.verifyPin(TEST_PIN);
    const seed = Buffer.from(await bip39.mnemonicToSeed(TEST_MNEMONIC));
    pubkeyBytes = await card.importSeed(new Uint8Array(seed));
    expect(pubkeyBytes).toHaveLength(32);
  }, 30_000);

  it('getStatus: isSeeded true after importSeed()', async () => {
    const status = await card.getStatus();
    expect(status.isSeeded).toBe(true);
  });

  // ── 5. Public key derivation ───────────────────────────────────────────────

  it('getPublicKey: returns same 32-byte key as importSeed()', async () => {
    const pubkey = await card.getPublicKey(SOLANA_PATH);
    expect(pubkey).toHaveLength(32);
    expect(pubkey).toEqual(pubkeyBytes);
  }, 30_000);

  // ── 6. Transaction signing ─────────────────────────────────────────────────

  it('signTransaction: returns valid 64-byte Ed25519 signature', async () => {
    const sig = await card.signTransaction(TEST_MESSAGE);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, TEST_MESSAGE, pubkeyBytes)).toBe(true);
  }, 30_000);

  it('signTransaction: large message (multi-chunk) produces valid signature', async () => {
    // 300 bytes forces at least 2 chunks (first cap = 200 - 13 header = 187)
    const largeMessage = new Uint8Array(300).fill(0xab);
    const sig = await card.signTransaction(largeMessage);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, largeMessage, pubkeyBytes)).toBe(true);
  }, 30_000);

  // ── 7. Card label ──────────────────────────────────────────────────────────

  it('getLabel: returns empty string on fresh card', async () => {
    expect(await card.getLabel()).toBe('');
  });

  it('setLabel / getLabel: round-trips a UTF-8 label', async () => {
    await card.setLabel(TEST_LABEL);
    expect(await card.getLabel()).toBe(TEST_LABEL);
  });

  it('setLabel: clears label when given empty string', async () => {
    await card.setLabel('');
    expect(await card.getLabel()).toBe('');
  });

  // ── 8. PIN change ──────────────────────────────────────────────────────────

  it('changePin: new PIN accepted after change', async () => {
    await card.changePin(TEST_PIN, TEST_PIN_NEW);
    await selectAndOpenChannel(card);
    await expect(card.verifyPin(TEST_PIN_NEW)).resolves.toBeUndefined();
  });

  it('changePin: restore original PIN', async () => {
    await card.changePin(TEST_PIN_NEW, TEST_PIN);
    await selectAndOpenChannel(card);
    await expect(card.verifyPin(TEST_PIN)).resolves.toBeUndefined();
  });

  // ── 9. Seed reset ──────────────────────────────────────────────────────────

  it('resetSeed: clears seed; getStatus shows isSeeded=false', async () => {
    await card.resetSeed();
    const status = await card.getStatus();
    expect(status.isSeeded).toBe(false);
  });

  // ── 10. Re-import and verify determinism ───────────────────────────────────

  it('re-importSeed: produces the same public key as the first import', async () => {
    const seed = Buffer.from(await bip39.mnemonicToSeed(TEST_MNEMONIC));
    const pubkey2 = await card.importSeed(new Uint8Array(seed));
    expect(pubkey2).toEqual(pubkeyBytes);
  }, 30_000);

  // ── 11. Factory reset ──────────────────────────────────────────────────────

  it('resetToFactory: wipes card; status shows setup not done', async () => {
    await card.resetToFactory();
    await selectAndOpenChannel(card);
    const status = await card.getStatus();
    expect(status.setupDone).toBe(false);
    expect(status.isSeeded).toBe(false);
  });
});
