import {
  APPLET_AID,
  INS,
  SIGN_P1,
  SW,
  SOLANA_PATH,
  PIN_MIN_SIZE,
  PIN_MAX_SIZE,
  LABEL_MAX_SIZE,
  SIGN_CHUNK_SIZE,
} from './constants';
import { selectApplet, sendApdu, sendApduChecked } from './apdu';
import { SecureChannel } from './secure-channel';
import {
  ApduResponse,
  CardError,
  CardStatus,
  CardTransport,
  HandshakeResult,
} from './types';

/**
 * High-level client for the TapiocaApplet JavaCard hardware wallet.
 *
 * Transport-agnostic — pass any `CardTransport` implementation
 * (PC/SC, react-native-nfc-manager, WebNFC, etc.).
 *
 * @example
 * ```ts
 * const card = new TapiocaCard(myTransport);
 * await card.select();
 * const status = await card.getStatus();
 * if (!status.setupDone) await card.setup(pin, puk);
 * await card.verifyPin(pin);
 * const pubkey = await card.importSeed(seed64);
 * const signature = await card.signTransaction(messageBytes);
 * ```
 */
export class TapiocaCard {
  private readonly transport: CardTransport;

  /** Secure channel client — use for encrypted communication. */
  readonly sc: SecureChannel;

  constructor(transport: CardTransport) {
    this.transport = transport;
    this.sc = new SecureChannel();
  }

  // ── Session management ───────────────────────────────────────────────────

  /** SELECT the TapiocaApplet. Call this first after every NFC tap. */
  async select(): Promise<void> {
    this.sc.reset();
    await selectApplet(this.transport, APPLET_AID);
  }

  // ── Status ───────────────────────────────────────────────────────────────

  /** Read card status (no authentication required). */
  async getStatus(): Promise<CardStatus> {
    const d = await sendApduChecked(this.transport, INS.GET_STATUS, 0x00, 0x00);
    return {
      protocolMajor: d[0],
      protocolMinor: d[1],
      appletMajor: d[2],
      appletMinor: d[3],
      pinTriesLeft: d[4],
      pinTriesMax: d[5],
      pukTriesLeft: d[6],
      pukTriesMax: d[7],
      isSeeded: d[8] === 0x01,
      secureChannelActive: d[9] === 0x01,
      setupDone: d[10] === 0x01,
    };
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  /**
   * First-time card setup — sets PIN and PUK.
   * Can only be called once. Throws SW 0x9C03 if already done.
   */
  async setup(pin: Uint8Array, puk: Uint8Array): Promise<void> {
    this.validatePinLength(pin, 'PIN');
    this.validatePinLength(puk, 'PUK');
    const data = new Uint8Array(1 + pin.length + 1 + puk.length);
    data[0] = pin.length;
    data.set(pin, 1);
    data[1 + pin.length] = puk.length;
    data.set(puk, 2 + pin.length);
    await this.cmd(INS.SETUP, 0x00, 0x00, data);
  }

  // ── PIN management ───────────────────────────────────────────────────────

  /**
   * Verify PIN for the current session.
   * Must be called after every SELECT (every NFC tap).
   * @throws CardError with `triesRemaining` on wrong PIN.
   */
  async verifyPin(pin: Uint8Array): Promise<void> {
    await this.cmd(INS.VERIFY_PIN, 0x00, 0x00, pin);
  }

  /**
   * Change PIN (requires PIN verified in current session).
   * @param oldPin Current PIN
   * @param newPin New PIN (4-16 bytes)
   */
  async changePin(oldPin: Uint8Array, newPin: Uint8Array): Promise<void> {
    this.validatePinLength(newPin, 'new PIN');
    const data = new Uint8Array(1 + oldPin.length + 1 + newPin.length);
    data[0] = oldPin.length;
    data.set(oldPin, 1);
    data[1 + oldPin.length] = newPin.length;
    data.set(newPin, 2 + oldPin.length);
    await this.cmd(INS.CHANGE_PIN, 0x00, 0x00, data);
  }

  /**
   * Unblock a locked PIN using the PUK.
   * @param puk PUK value
   * @param newPin New PIN to set (4-16 bytes)
   */
  async unblockPin(puk: Uint8Array, newPin: Uint8Array): Promise<void> {
    this.validatePinLength(newPin, 'new PIN');
    const data = new Uint8Array(1 + puk.length + 1 + newPin.length);
    data[0] = puk.length;
    data.set(puk, 1);
    data[1 + puk.length] = newPin.length;
    data.set(newPin, 2 + puk.length);
    await this.cmd(INS.UNBLOCK_PIN, 0x00, 0x00, data);
  }

  // ── Seed & keys ──────────────────────────────────────────────────────────

  /**
   * Import a 64-byte BIP-39 seed. Requires PIN verified.
   * Returns the 32-byte Ed25519 public key at m/44'/501'/0'.
   *
   * This takes ~2,700 ms on J3R180 (SLIP-0010 derivation + Ed25519 key setup).
   */
  async importSeed(seed: Uint8Array): Promise<Uint8Array> {
    if (seed.length !== 64) throw new Error('Seed must be exactly 64 bytes');
    return this.cmd(INS.IMPORT_SEED, 0x00, 0x00, seed);
  }

  /** Wipe the seed and master key material. Requires PIN verified. */
  async resetSeed(): Promise<void> {
    await this.cmd(INS.RESET_SEED, 0x00, 0x00);
  }

  /**
   * Derive and return the 32-byte Ed25519 public key at the given path.
   * Requires PIN verified and seed imported.
   *
   * @param path Array of hardened indexes (e.g., `SOLANA_PATH` for m/44'/501'/0')
   *
   * This takes ~2,700 ms on J3R180.
   */
  async getPublicKey(
    path: readonly number[] = SOLANA_PATH
  ): Promise<Uint8Array> {
    const data = new Uint8Array(1 + path.length * 4);
    data[0] = path.length;
    for (let i = 0; i < path.length; i++) {
      const off = 1 + i * 4;
      data[off] = (path[i] >>> 24) & 0xff;
      data[off + 1] = (path[i] >>> 16) & 0xff;
      data[off + 2] = (path[i] >>> 8) & 0xff;
      data[off + 3] = path[i] & 0xff;
    }
    return this.cmd(INS.GET_PUBLIC_KEY, 0x00, 0x00, data);
  }

  // ── Transaction signing ──────────────────────────────────────────────────

  /**
   * Sign a Solana transaction message (blind signing).
   * Requires PIN verified and seed imported.
   *
   * @param message Serialized transaction message bytes (max 1,200 bytes).
   *   This is the output of `transaction.serializeMessage()` from @solana/web3.js.
   * @param path Derivation path (defaults to m/44'/501'/0')
   * @returns 64-byte Ed25519 signature
   *
   * Automatically handles multi-chunk streaming for messages > ~187 bytes.
   * Total time: ~4,200 ms on J3R180 (2,700 ms derivation + 1,440 ms signing).
   */
  async signTransaction(
    message: Uint8Array,
    path: readonly number[] = SOLANA_PATH
  ): Promise<Uint8Array> {
    // Build path header: [depth(1)] [idx_0(4)] ... [idx_n(4)]
    const header = new Uint8Array(1 + path.length * 4);
    header[0] = path.length;
    for (let i = 0; i < path.length; i++) {
      const off = 1 + i * 4;
      header[off] = (path[i] >>> 24) & 0xff;
      header[off + 1] = (path[i] >>> 16) & 0xff;
      header[off + 2] = (path[i] >>> 8) & 0xff;
      header[off + 3] = path[i] & 0xff;
    }

    const firstMsgCap = SIGN_CHUNK_SIZE - header.length;
    const firstMsgLen = Math.min(message.length, firstMsgCap);
    const firstChunkData = new Uint8Array(header.length + firstMsgLen);
    firstChunkData.set(header);
    firstChunkData.set(message.slice(0, firstMsgLen), header.length);

    const remaining = message.slice(firstMsgLen);

    if (remaining.length === 0) {
      // Single chunk
      return this.cmd(INS.SIGN_TX, SIGN_P1.FIRST_LAST, 0x00, firstChunkData);
    }

    // Multi-chunk: first
    await this.cmd(INS.SIGN_TX, SIGN_P1.FIRST, 0x00, firstChunkData);

    // Middle + last chunks
    let offset = 0;
    while (offset < remaining.length) {
      const end = Math.min(offset + SIGN_CHUNK_SIZE, remaining.length);
      const chunk = remaining.slice(offset, end);
      const isLast = end >= remaining.length;

      if (isLast) {
        return this.cmd(INS.SIGN_TX, SIGN_P1.LAST, 0x00, chunk);
      } else {
        await this.cmd(INS.SIGN_TX, SIGN_P1.CONTINUATION, 0x00, chunk);
      }
      offset = end;
    }

    // Should never reach here
    throw new Error('signTransaction: unexpected end of chunking');
  }

  // ── Card label ───────────────────────────────────────────────────────────

  /**
   * Read the card label (no authentication required).
   * Returns the label as a UTF-8 string (empty string if not set).
   */
  async getLabel(): Promise<string> {
    const data = await sendApduChecked(this.transport, INS.CARD_LABEL, 0x00, 0x00);
    const len = data[0];
    if (len === 0) return '';
    return new TextDecoder().decode(data.slice(1, 1 + len));
  }

  /**
   * Set the card label (requires PIN verified).
   * @param label UTF-8 string, max 64 bytes. Empty string clears the label.
   */
  async setLabel(label: string): Promise<void> {
    const encoded = new TextEncoder().encode(label);
    if (encoded.length > LABEL_MAX_SIZE) {
      throw new Error(
        `Label too long: ${encoded.length} bytes (max ${LABEL_MAX_SIZE})`
      );
    }
    const data = new Uint8Array(1 + encoded.length);
    data[0] = encoded.length;
    data.set(encoded, 1);
    await this.cmd(INS.CARD_LABEL, 0x01, 0x00, data);
  }

  // ── Authentikey ──────────────────────────────────────────────────────────

  /**
   * Export the card's persistent 65-byte SECP256K1 identity public key.
   * No authentication required.
   */
  async exportAuthentikey(): Promise<Uint8Array> {
    return this.sc.exportAuthentikey(this.transport);
  }

  // ── Secure channel ───────────────────────────────────────────────────────

  /**
   * Perform the ECDH secure channel handshake.
   * After this, use `sendSecure()` for encrypted commands.
   */
  async initSecureChannel(): Promise<HandshakeResult> {
    return this.sc.handshake(this.transport);
  }

  /**
   * Send a command through the secure channel.
   * Requires `initSecureChannel()` to have been called.
   * @returns Raw ApduResponse (check sw, data is still encrypted).
   */
  async sendSecure(
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array
  ): Promise<ApduResponse> {
    return this.sc.send(this.transport, ins, p1, p2, data);
  }

  /**
   * Send a command through the secure channel; throw on non-9000 SW.
   * @returns Decrypted response data.
   */
  async sendSecureChecked(
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
    expectedSw = 0x9000
  ): Promise<Uint8Array> {
    return this.sc.sendChecked(this.transport, ins, p1, p2, data, expectedSw);
  }

  // ── Factory reset ────────────────────────────────────────────────────────

  /**
   * Factory reset — wipes PIN, PUK, seed, label, secure channel.
   * Requires PIN verified. Returns the card to fresh/uninitialized state.
   * @returns true on success (SW = 0xFF00)
   */
  async resetToFactory(): Promise<void> {
    await this.cmd(INS.RESET_TO_FACTORY, 0x00, 0x00, undefined, SW.RESET_TO_FACTORY);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Send an authenticated command, routing through the secure channel when
   * it is active. Public commands that require no authentication (getStatus,
   * getLabel read, exportAuthentikey) must call sendApduChecked directly
   * because the applet rejects SC-wrapped reads on a fresh card.
   */
  private async cmd(
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
    expectedSw = 0x9000
  ): Promise<Uint8Array> {
    if (this.sc.isActive) {
      return this.sc.sendChecked(this.transport, ins, p1, p2, data, expectedSw);
    }
    return sendApduChecked(this.transport, ins, p1, p2, data, expectedSw);
  }

  private validatePinLength(pin: Uint8Array, name: string): void {
    if (pin.length < PIN_MIN_SIZE || pin.length > PIN_MAX_SIZE) {
      throw new Error(
        `${name} must be ${PIN_MIN_SIZE}-${PIN_MAX_SIZE} bytes, got ${pin.length}`
      );
    }
  }
}
