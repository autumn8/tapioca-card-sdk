/**
 * Minimal happy-path E2E test — mirrors the reference e2e's linear flow.
 *
 * select → handshake → setup → verifyPin → importSeed → sign
 *
 * No factory resets, PIN exhaustion, SC re-inits, or unblock cycles.
 * If this passes but the full suite's signTransaction fails, the issue
 * is state accumulation from earlier tests.
 *
 * Prerequisites:
 *   - A TapiocaApplet JavaCard must be connected via a PC/SC reader.
 *   - The card must be in a fresh (un-setup) state, OR already set up
 *     with the TEST_PIN / TEST_PUK below (it will factory-reset first).
 *
 * Run:
 *   npx vitest run --config vitest.e2e.config.ts e2e/happy-path.e2e.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bip39 from 'bip39';
import { ed25519 } from '@noble/curves/ed25519';
import { TapiocaCard, SOLANA_PATH } from '../src';
import { PcscTransport } from './transport';

const TEST_MNEMONIC =
  'always thunder family peasant ancient pioneer nut vote detect monster shaft timber prepare program clump awake unable error garden shield sand fossil orphan clump';
const TEST_PIN = new TextEncoder().encode('1234');
const TEST_PUK = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x46]); // "ABCDEF"

describe('Happy-path E2E (reference-style linear flow)', () => {
  let transport: PcscTransport;
  let card: TapiocaCard;
  let pubkeyBytes: Uint8Array;

  beforeAll(async () => {
    transport = await PcscTransport.connect(30_000);
    card = new TapiocaCard(transport);

    // Ensure clean slate — factory reset if already set up
    await card.select();
    await card.initSecureChannel();
    const status = await card.getStatus();
    if (status.setupDone) {
      await card.verifyPin(TEST_PIN);
      await card.resetToFactory();
    }
  }, 120_000);

  afterAll(() => {
    transport?.disconnect();
  });

  // Single SC session for setup + verify + import + sign (mirrors reference)
  it('select + handshake', async () => {
    await card.select();
    await card.initSecureChannel();
  });

  it('setup', async () => {
    await card.setup(TEST_PIN, TEST_PUK);
    const status = await card.getStatus();
    expect(status.setupDone).toBe(true);
  });

  it('verifyPin', async () => {
    await card.verifyPin(TEST_PIN);
  });

  it('importSeed', async () => {
    const seed = Buffer.from(await bip39.mnemonicToSeed(TEST_MNEMONIC));
    pubkeyBytes = await card.importSeed(new Uint8Array(seed));
    expect(pubkeyBytes).toHaveLength(32);
  }, 30_000);

  it('getPublicKey matches importSeed', async () => {
    const pubkey = await card.getPublicKey(SOLANA_PATH);
    expect(pubkey).toEqual(pubkeyBytes);
  }, 30_000);

  it('signTransaction: single chunk', async () => {
    const message = new Uint8Array(50).fill(0x42);
    const sig = await card.signTransaction(message);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, message, pubkeyBytes)).toBe(true);
  }, 30_000);

  it('signTransaction: multi-chunk', async () => {
    const message = new Uint8Array(300).fill(0xab);
    const sig = await card.signTransaction(message);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, message, pubkeyBytes)).toBe(true);
  }, 30_000);

  // Clean up — leave card in fresh state for other test suites
  it('factory reset', async () => {
    await card.resetToFactory();
    await card.select();
    await card.initSecureChannel();
    const status = await card.getStatus();
    expect(status.setupDone).toBe(false);
  });
});
