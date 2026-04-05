import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecureChannel } from '../secure-channel';
import { CardTransport } from '../types';
import { cbc } from '@noble/ciphers/aes';
import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/sha1';

describe('SecureChannel', () => {
  let sc: SecureChannel;

  beforeEach(() => {
    sc = new SecureChannel();
  });

  describe('isActive', () => {
    it('starts as inactive', () => {
      expect(sc.isActive).toBe(false);
    });
  });

  describe('authentikeyBytes', () => {
    it('starts as null', () => {
      expect(sc.authentikeyBytes).toBeNull();
    });
  });

  describe('reset', () => {
    it('can be called on a fresh instance without error', () => {
      expect(() => sc.reset()).not.toThrow();
      expect(sc.isActive).toBe(false);
    });
  });

  describe('exportAuthentikey', () => {
    it('throws on non-65-byte response', async () => {
      const transport: CardTransport = {
        transmit: vi.fn().mockResolvedValue(new Uint8Array([
          ...new Array(32).fill(0x01), 0x90, 0x00,
        ])),
      };
      await expect(sc.exportAuthentikey(transport)).rejects.toThrow('Invalid authentikey');
    });

    it('throws when first byte is not 0x04', async () => {
      const key = new Uint8Array(65);
      key[0] = 0x02; // compressed, not uncompressed
      const resp = new Uint8Array(67);
      resp.set(key, 0);
      resp[65] = 0x90;
      resp[66] = 0x00;
      const transport: CardTransport = {
        transmit: vi.fn().mockResolvedValue(resp),
      };
      await expect(sc.exportAuthentikey(transport)).rejects.toThrow('Invalid authentikey');
    });

    it('stores and returns a valid 65-byte uncompressed key', async () => {
      const key = new Uint8Array(65);
      key[0] = 0x04;
      for (let i = 1; i < 65; i++) key[i] = i;
      const resp = new Uint8Array(67);
      resp.set(key, 0);
      resp[65] = 0x90;
      resp[66] = 0x00;
      const transport: CardTransport = {
        transmit: vi.fn().mockResolvedValue(resp),
      };
      const result = await sc.exportAuthentikey(transport);
      expect(result.length).toBe(65);
      expect(result[0]).toBe(0x04);
      expect(sc.authentikeyBytes).toEqual(result);
    });
  });

  describe('send (before handshake)', () => {
    it('throws when sending without handshake', async () => {
      const transport: CardTransport = {
        transmit: vi.fn(),
      };
      await expect(sc.send(transport, 0x42, 0x00, 0x00))
        .rejects.toThrow('Secure channel not initialized');
    });
  });

  describe('wrapCommand / decryptResponse round-trip', () => {
    it('encrypts and decrypts a payload correctly', () => {
      // Manually set session keys to test the crypto
      const sessionKey = new Uint8Array(16);
      sessionKey.fill(0xab);
      const macKey = new Uint8Array(20);
      macKey.fill(0xcd);

      // Access private members via any for testing
      const scAny = sc as any;
      scAny.sessionKey = sessionKey;
      scAny.macKey = macKey;
      scAny.counter = 0;

      expect(sc.isActive).toBe(true);

      // Wrap a command
      const wrapped = scAny.wrapCommand(0x42, 0x00, 0x00, new Uint8Array([0x31, 0x32, 0x33, 0x34]));

      // Verify structure: IV(16) + size(2) + encrypted + mac_size(2) + mac(20)
      expect(wrapped.length).toBeGreaterThan(40);

      // Extract IV
      const iv = wrapped.slice(0, 16);
      // Counter must be in bytes 12-15, last byte odd
      expect(iv[15] & 0x01).toBe(1);

      // Extract encrypted data
      const encSize = (wrapped[16] << 8) | wrapped[17];
      const encrypted = wrapped.slice(18, 18 + encSize);

      // Verify MAC
      const macOff = 18 + encSize;
      const macSizeField = (wrapped[macOff] << 8) | wrapped[macOff + 1];
      expect(macSizeField).toBe(20);
      const mac = wrapped.slice(macOff + 2, macOff + 22);

      // Recompute MAC
      const macInput = new Uint8Array(16 + 2 + encSize);
      macInput.set(iv, 0);
      macInput[16] = (encSize >>> 8) & 0xff;
      macInput[17] = encSize & 0xff;
      macInput.set(encrypted, 18);
      const expectedMac = hmac(sha1, macKey, macInput);
      expect(Array.from(mac)).toEqual(Array.from(expectedMac));

      // Decrypt and verify plaintext (disablePadding to match card's NOPAD mode)
      const decipher = cbc(sessionKey, iv, { disablePadding: true });
      const padded = decipher.decrypt(encrypted);
      const padByte = padded[padded.length - 1];
      const plaintext = padded.slice(0, padded.length - padByte);

      // Inner APDU: CLA(b0) INS(42) P1(00) P2(00) Lc(04) data(31 32 33 34)
      expect(plaintext[0]).toBe(0xb0);
      expect(plaintext[1]).toBe(0x42);
      expect(plaintext[4]).toBe(4);
      expect(plaintext[5]).toBe(0x31);
    });

    it('decryptResponse returns empty for short data', () => {
      const scAny = sc as any;
      scAny.sessionKey = new Uint8Array(16);
      const result = scAny.decryptResponse(new Uint8Array(10));
      expect(result.length).toBe(0);
    });

    it('counter increments on each wrap', () => {
      const scAny = sc as any;
      scAny.sessionKey = new Uint8Array(16);
      scAny.macKey = new Uint8Array(20);
      scAny.counter = 0;

      scAny.wrapCommand(0x42, 0x00, 0x00);
      expect(scAny.counter).toBe(1);

      scAny.wrapCommand(0x42, 0x00, 0x00);
      expect(scAny.counter).toBe(2);
    });
  });

  describe('reset clears state', () => {
    it('resets keys and counter', () => {
      const scAny = sc as any;
      scAny.sessionKey = new Uint8Array(16);
      scAny.macKey = new Uint8Array(20);
      scAny.counter = 5;

      expect(sc.isActive).toBe(true);
      sc.reset();
      expect(sc.isActive).toBe(false);
      expect(scAny.counter).toBe(0);
    });
  });
});
