import { secp256k1 } from '@noble/curves/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/sha1';
import { cbc } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { INS } from './constants';
import { sendApdu, sendApduChecked } from './apdu';
import { ApduResponse, CardError, CardTransport, HandshakeResult } from './types';

/** AES-128 CBC + HMAC-SHA1 secure channel client. */
export class SecureChannel {
  private sessionKey: Uint8Array | null = null;
  private macKey: Uint8Array | null = null;
  private counter = 0;
  private _authentikeyBytes: Uint8Array | null = null;

  /** Whether the secure channel has been established. */
  get isActive(): boolean {
    return this.sessionKey !== null;
  }

  /** Raw 65-byte authentikey public key (available after exportAuthentikey). */
  get authentikeyBytes(): Uint8Array | null {
    return this._authentikeyBytes;
  }

  /** Clear session state (call after deselect / NFC disconnect). */
  reset(): void {
    this.sessionKey = null;
    this.macKey = null;
    this.counter = 0;
  }

  /** Fetch the card's 65-byte persistent identity public key. */
  async exportAuthentikey(transport: CardTransport): Promise<Uint8Array> {
    const data = await sendApduChecked(transport, INS.EXPORT_AUTHENTIKEY, 0x00, 0x00);
    if (data.length !== 65 || data[0] !== 0x04) {
      throw new Error(`Invalid authentikey: expected 65-byte uncompressed point, got ${data.length} bytes`);
    }
    this._authentikeyBytes = data;
    return data;
  }

  /**
   * Perform the ECDH handshake (INS_INIT_SECURE_CHANNEL).
   * After this returns, use `wrap()` and `unwrap()` for encrypted communication.
   */
  async handshake(transport: CardTransport): Promise<HandshakeResult> {
    // Generate ephemeral client keypair
    const clientPriv = secp256k1.utils.randomPrivateKey();
    const clientPub = secp256k1.getPublicKey(clientPriv, false); // 65 bytes uncompressed

    const data = await sendApduChecked(
      transport, INS.INIT_SECURE_CHANNEL, 0x00, 0x00, clientPub,
    );

    // Parse response: [coordX_size(2) | coordX(32) | sig1_size(2) | sig1 | sig2_size(2) | sig2]
    let off = 0;
    const coordXSize = (data[off] << 8) | data[off + 1]; off += 2;
    if (coordXSize !== 32) throw new Error(`Unexpected coordX size: ${coordXSize}`);
    const coordX = data.slice(off, off + 32); off += 32;

    const sig1Size = (data[off] << 8) | data[off + 1]; off += 2;
    const sig1 = data.slice(off, off + sig1Size); off += sig1Size;

    const sig2Size = (data[off] << 8) | data[off + 1]; off += 2;
    const sig2 = data.slice(off, off + sig2Size);

    // Reconstruct card's ephemeral public key from X coordinate (try both parities)
    let sharedX: Uint8Array | null = null;
    for (const prefix of [0x02, 0x03]) {
      try {
        const compressed = new Uint8Array(33);
        compressed[0] = prefix;
        compressed.set(coordX, 1);
        const cardPub = secp256k1.ProjectivePoint.fromHex(compressed);
        const shared = secp256k1.getSharedSecret(clientPriv, cardPub.toRawBytes(false));
        // getSharedSecret returns 33 bytes (compressed) or 65 bytes; we need the X coordinate
        // noble/secp256k1 getSharedSecret returns the full point; extract X (bytes 1..33)
        sharedX = shared.slice(1, 33);
        break;
      } catch {
        continue;
      }
    }
    if (!sharedX) throw new Error('Failed to reconstruct ephemeral public key from coordX');

    // Derive session keys: HMAC-SHA1(shared_X, "sc_key")[0:16] and HMAC-SHA1(shared_X, "sc_mac")
    const sessionKey = hmac(sha1, sharedX, new TextEncoder().encode('sc_key')).slice(0, 16);
    const macKey = hmac(sha1, sharedX, new TextEncoder().encode('sc_mac'));

    this.sessionKey = sessionKey;
    this.macKey = macKey;
    this.counter = 0;

    return { ephemeralCoordX: coordX, sig1, sig2, sessionKey, macKey };
  }

  /**
   * Wrap an inner command in INS_PROCESS_SECURE_CHANNEL and send it.
   * Returns the full ApduResponse (SW reflects the inner command's result).
   */
  async send(
    transport: CardTransport,
    innerIns: number,
    innerP1: number,
    innerP2: number,
    innerData?: Uint8Array,
  ): Promise<ApduResponse> {
    if (!this.sessionKey || !this.macKey) {
      throw new Error('Secure channel not initialized — call handshake() first');
    }

    const payload = this.wrapCommand(innerIns, innerP1, innerP2, innerData);
    return sendApdu(transport, INS.PROCESS_SECURE_CHANNEL, 0x00, 0x00, payload);
  }

  /**
   * Same as send() but throws CardError if SW !== expectedSw.
   * Returns decrypted response data.
   */
  async sendChecked(
    transport: CardTransport,
    innerIns: number,
    innerP1: number,
    innerP2: number,
    innerData?: Uint8Array,
    expectedSw = 0x9000,
  ): Promise<Uint8Array> {
    const resp = await this.send(transport, innerIns, innerP1, innerP2, innerData);
    if (resp.sw !== expectedSw) {
      throw new CardError(
        `Wrapped INS 0x${innerIns.toString(16)} failed: SW=${resp.sw.toString(16).toUpperCase().padStart(4, '0')}`,
        resp.sw,
      );
    }
    // Decrypt response if present
    if (resp.data.length > 0) {
      return this.decryptResponse(resp.data);
    }
    return resp.data;
  }

  // ── Internal crypto ────────────────────────────────────────────────────────

  private wrapCommand(
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Uint8Array {
    const sk = this.sessionKey!;
    const mk = this.macKey!;

    // Build inner APDU plaintext
    const innerLen = data ? data.length : 0;
    const plaintext = new Uint8Array(5 + innerLen);
    plaintext[0] = 0xb0; // CLA
    plaintext[1] = ins;
    plaintext[2] = p1;
    plaintext[3] = p2;
    plaintext[4] = innerLen;
    if (data) plaintext.set(data, 5);

    // PKCS#7 pad
    const padLen = 16 - (plaintext.length % 16);
    const padded = new Uint8Array(plaintext.length + padLen);
    padded.set(plaintext);
    padded.fill(padLen, plaintext.length);

    // Generate IV: 12 random bytes + 4-byte counter, last byte must be odd
    this.counter++;
    const iv = new Uint8Array(16);
    iv.set(randomBytes(12), 0);
    iv[12] = (this.counter >>> 24) & 0xff;
    iv[13] = (this.counter >>> 16) & 0xff;
    iv[14] = (this.counter >>> 8) & 0xff;
    iv[15] = this.counter & 0xff;
    iv[15] |= 0x01; // ensure odd

    // Encrypt
    const cipher = cbc(sk, iv);
    const encrypted = cipher.encrypt(padded);

    // MAC: HMAC-SHA1(mac_key, IV || data_size(2) || encrypted)
    const macInput = new Uint8Array(16 + 2 + encrypted.length);
    macInput.set(iv, 0);
    macInput[16] = (encrypted.length >>> 8) & 0xff;
    macInput[17] = encrypted.length & 0xff;
    macInput.set(encrypted, 18);
    const mac = hmac(sha1, mk, macInput);

    // Assemble: IV(16) + data_size(2) + encrypted + mac_size(2) + mac(20)
    const payload = new Uint8Array(16 + 2 + encrypted.length + 2 + 20);
    payload.set(iv, 0);
    payload[16] = (encrypted.length >>> 8) & 0xff;
    payload[17] = encrypted.length & 0xff;
    payload.set(encrypted, 18);
    const macOff = 18 + encrypted.length;
    payload[macOff] = 0x00;
    payload[macOff + 1] = 0x14; // 20
    payload.set(mac, macOff + 2);

    return payload;
  }

  private decryptResponse(data: Uint8Array): Uint8Array {
    if (data.length < 18) return new Uint8Array(0);
    const sk = this.sessionKey!;

    const iv = data.slice(0, 16);
    const encSize = (data[16] << 8) | data[17];
    const ciphertext = data.slice(18, 18 + encSize);

    const decipher = cbc(sk, iv);
    const padded = decipher.decrypt(ciphertext);

    // Remove PKCS#7 padding
    const padByte = padded[padded.length - 1];
    return padded.slice(0, padded.length - padByte);
  }
}
