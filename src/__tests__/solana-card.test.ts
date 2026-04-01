import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SolanaCard } from '../solana-card';
import { CardError, CardTransport } from '../types';
import { CLA, INS, SIGN_P1, SOLANA_PATH, SIGN_CHUNK_SIZE } from '../constants';

/** Create a mock transport that returns predefined responses for each transmit call. */
function createMockTransport(responses: Uint8Array[]): CardTransport & { calls: Uint8Array[] } {
  let callIndex = 0;
  const calls: Uint8Array[] = [];
  return {
    calls,
    transmit: vi.fn(async (cmd: Uint8Array) => {
      calls.push(cmd);
      if (callIndex >= responses.length) {
        throw new Error(`Unexpected transmit call #${callIndex}`);
      }
      return responses[callIndex++];
    }),
  };
}

/** Build a mock success response with data. */
function ok(data: number[] = []): Uint8Array {
  return new Uint8Array([...data, 0x90, 0x00]);
}

describe('SolanaCard', () => {
  let card: SolanaCard;

  describe('select', () => {
    it('sends ISO SELECT with correct AID', async () => {
      const transport = createMockTransport([ok()]);
      card = new SolanaCard(transport);
      await card.select();

      const cmd = transport.calls[0];
      expect(cmd[0]).toBe(0x00); // CLA
      expect(cmd[1]).toBe(0xa4); // SELECT
      expect(cmd[4]).toBe(7);    // AID length
      // AID: "Solana\0"
      expect(Array.from(cmd.slice(5, 12))).toEqual([0x53, 0x6f, 0x6c, 0x61, 0x6e, 0x61, 0x00]);
    });

    it('resets secure channel on select', async () => {
      const transport = createMockTransport([ok()]);
      card = new SolanaCard(transport);
      await card.select();
      expect(card.sc.isActive).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('parses 11-byte status response', async () => {
      const statusBytes = [
        0x00, 0x01, // protocol v0.1
        0x00, 0x01, // applet v0.1
        0x03,       // pin tries left
        0x05,       // pin tries max
        0x03,       // puk tries left
        0x05,       // puk tries max
        0x01,       // is_seeded = true
        0x00,       // sc_active = false
        0x01,       // setup_done = true
      ];
      const transport = createMockTransport([ok(statusBytes)]);
      card = new SolanaCard(transport);

      const status = await card.getStatus();
      expect(status.protocolMajor).toBe(0);
      expect(status.protocolMinor).toBe(1);
      expect(status.pinTriesLeft).toBe(3);
      expect(status.pinTriesMax).toBe(5);
      expect(status.isSeeded).toBe(true);
      expect(status.secureChannelActive).toBe(false);
      expect(status.setupDone).toBe(true);
    });
  });

  describe('setup', () => {
    it('formats PIN and PUK with length prefixes', async () => {
      const transport = createMockTransport([ok()]);
      card = new SolanaCard(transport);
      const pin = new Uint8Array([0x31, 0x32, 0x33, 0x34]); // "1234"
      const puk = new Uint8Array([0x35, 0x36, 0x37, 0x38, 0x39, 0x30]); // "567890"

      await card.setup(pin, puk);

      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.SETUP);
      // Data: pin_len(1) + pin(4) + puk_len(1) + puk(6) = 12 bytes
      expect(cmd[4]).toBe(12); // Lc
      expect(cmd[5]).toBe(4);  // pin length
      expect(cmd[10]).toBe(6); // puk length
    });

    it('rejects PIN shorter than 4 bytes', async () => {
      const transport = createMockTransport([]);
      card = new SolanaCard(transport);
      await expect(card.setup(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4])))
        .rejects.toThrow('PIN must be 4-16 bytes');
    });

    it('rejects PIN longer than 16 bytes', async () => {
      const transport = createMockTransport([]);
      card = new SolanaCard(transport);
      await expect(card.setup(new Uint8Array(17), new Uint8Array([1, 2, 3, 4])))
        .rejects.toThrow('PIN must be 4-16 bytes');
    });
  });

  describe('verifyPin', () => {
    it('sends VERIFY_PIN with pin data', async () => {
      const transport = createMockTransport([ok()]);
      card = new SolanaCard(transport);
      await card.verifyPin(new Uint8Array([0x31, 0x32, 0x33, 0x34]));

      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.VERIFY_PIN);
    });

    it('throws CardError with triesRemaining on wrong PIN', async () => {
      const transport = createMockTransport([new Uint8Array([0x63, 0xc2])]);
      card = new SolanaCard(transport);
      try {
        await card.verifyPin(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CardError);
        expect((e as CardError).triesRemaining).toBe(2);
      }
    });
  });

  describe('changePin', () => {
    it('formats old and new PIN with length prefixes', async () => {
      const transport = createMockTransport([ok()]);
      card = new SolanaCard(transport);
      await card.changePin(
        new Uint8Array([0x31, 0x32, 0x33, 0x34]),
        new Uint8Array([0x35, 0x36, 0x37, 0x38]),
      );
      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.CHANGE_PIN);
      expect(cmd[5]).toBe(4); // old pin len
      expect(cmd[10]).toBe(4); // new pin len
    });
  });

  describe('importSeed', () => {
    it('sends 64-byte seed', async () => {
      const pubkey = new Array(32).fill(0xab);
      const transport = createMockTransport([ok(pubkey)]);
      card = new SolanaCard(transport);
      const seed = new Uint8Array(64);
      seed.fill(0x42);

      const result = await card.importSeed(seed);
      expect(result.length).toBe(32);
      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.IMPORT_SEED);
      expect(cmd[4]).toBe(64); // Lc
    });

    it('rejects non-64-byte seed', async () => {
      const transport = createMockTransport([]);
      card = new SolanaCard(transport);
      await expect(card.importSeed(new Uint8Array(32))).rejects.toThrow('exactly 64 bytes');
    });
  });

  describe('getPublicKey', () => {
    it('sends path with depth prefix and big-endian indexes', async () => {
      const pubkey = new Array(32).fill(0xcc);
      const transport = createMockTransport([ok(pubkey)]);
      card = new SolanaCard(transport);

      await card.getPublicKey(SOLANA_PATH);

      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.GET_PUBLIC_KEY);
      // Data: depth(1) + 3 indexes * 4 bytes = 13 bytes
      expect(cmd[4]).toBe(13); // Lc
      expect(cmd[5]).toBe(3);  // depth
      // First index: 0x8000002c (big-endian)
      expect(cmd[6]).toBe(0x80);
      expect(cmd[7]).toBe(0x00);
      expect(cmd[8]).toBe(0x00);
      expect(cmd[9]).toBe(0x2c);
    });

    it('uses default SOLANA_PATH when no path given', async () => {
      const pubkey = new Array(32).fill(0xcc);
      const transport = createMockTransport([ok(pubkey)]);
      card = new SolanaCard(transport);

      await card.getPublicKey();

      const cmd = transport.calls[0];
      expect(cmd[5]).toBe(3); // depth = 3 (SOLANA_PATH has 3 elements)
    });
  });

  describe('signTransaction', () => {
    it('sends single-chunk for small messages', async () => {
      const sig = new Array(64).fill(0xde);
      const transport = createMockTransport([ok(sig)]);
      card = new SolanaCard(transport);

      const message = new Uint8Array(50);
      const result = await card.signTransaction(message);

      expect(result.length).toBe(64);
      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.SIGN_TX);
      expect(cmd[2]).toBe(SIGN_P1.FIRST_LAST);
    });

    it('sends multi-chunk for large messages', async () => {
      const sig = new Array(64).fill(0xde);
      // First chunk gets 9000, last chunk gets signature + 9000
      const transport = createMockTransport([ok(), ok(sig)]);
      card = new SolanaCard(transport);

      // Message larger than single chunk capacity
      // Header = 1 + 3*4 = 13 bytes, first chunk cap = 200 - 13 = 187
      const message = new Uint8Array(250);
      const result = await card.signTransaction(message);

      expect(result.length).toBe(64);
      expect(transport.calls.length).toBe(2);

      // First chunk: P1 = FIRST
      expect(transport.calls[0][2]).toBe(SIGN_P1.FIRST);
      // Last chunk: P1 = LAST
      expect(transport.calls[1][2]).toBe(SIGN_P1.LAST);
    });

    it('sends 3 chunks for messages that need continuation', async () => {
      const sig = new Array(64).fill(0xde);
      const transport = createMockTransport([ok(), ok(), ok(sig)]);
      card = new SolanaCard(transport);

      // 187 (first) + 200 (continuation) + remainder = need 3 chunks
      const message = new Uint8Array(500);
      const result = await card.signTransaction(message);

      expect(result.length).toBe(64);
      expect(transport.calls.length).toBe(3);
      expect(transport.calls[0][2]).toBe(SIGN_P1.FIRST);
      expect(transport.calls[1][2]).toBe(SIGN_P1.CONTINUATION);
      expect(transport.calls[2][2]).toBe(SIGN_P1.LAST);
    });
  });

  describe('getLabel', () => {
    it('returns empty string when label length is 0', async () => {
      const transport = createMockTransport([ok([0x00])]);
      card = new SolanaCard(transport);
      const label = await card.getLabel();
      expect(label).toBe('');
    });

    it('decodes UTF-8 label', async () => {
      const labelBytes = Array.from(new TextEncoder().encode('My Wallet'));
      const transport = createMockTransport([ok([labelBytes.length, ...labelBytes])]);
      card = new SolanaCard(transport);
      const label = await card.getLabel();
      expect(label).toBe('My Wallet');
    });
  });

  describe('setLabel', () => {
    it('encodes label with length prefix', async () => {
      const transport = createMockTransport([ok()]);
      card = new SolanaCard(transport);
      await card.setLabel('Test');

      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.CARD_LABEL);
      expect(cmd[2]).toBe(0x01); // P1 = set
      expect(cmd[5]).toBe(4);    // length
    });

    it('rejects labels longer than 64 bytes', async () => {
      const transport = createMockTransport([]);
      card = new SolanaCard(transport);
      await expect(card.setLabel('x'.repeat(65))).rejects.toThrow('Label too long');
    });
  });

  describe('resetToFactory', () => {
    it('sends RESET_TO_FACTORY and expects SW=0xFF00', async () => {
      const transport = createMockTransport([new Uint8Array([0xff, 0x00])]);
      card = new SolanaCard(transport);
      await card.resetToFactory();

      const cmd = transport.calls[0];
      expect(cmd[1]).toBe(INS.RESET_TO_FACTORY);
    });
  });
});
