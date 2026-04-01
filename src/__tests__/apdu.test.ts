import { describe, it, expect, vi } from 'vitest';
import { buildApdu, parseResponse, sendApdu, sendApduChecked, selectApplet } from '../apdu';
import { CLA } from '../constants';
import { CardError, CardTransport } from '../types';

// ── Mock transport ────────────────────────────────────────────────────────────

function mockTransport(response: number[]): CardTransport {
  return {
    transmit: vi.fn().mockResolvedValue(new Uint8Array(response)),
  };
}

// ── buildApdu ─────────────────────────────────────────────────────────────────

describe('buildApdu', () => {
  it('builds a header-only APDU with no data', () => {
    const apdu = buildApdu(0xb0, 0x3c, 0x00, 0x00);
    expect(Array.from(apdu)).toEqual([0xb0, 0x3c, 0x00, 0x00, 0x00]);
  });

  it('builds an APDU with data and appends Le', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const apdu = buildApdu(0xb0, 0x42, 0x00, 0x00, data);
    expect(Array.from(apdu)).toEqual([
      0xb0, 0x42, 0x00, 0x00,
      0x03,             // Lc
      0x01, 0x02, 0x03, // data
      0x00,             // Le
    ]);
  });

  it('sets Lc to the data length', () => {
    const data = new Uint8Array(10);
    const apdu = buildApdu(CLA, 0x6c, 0x00, 0x00, data);
    expect(apdu[4]).toBe(10);
    expect(apdu.length).toBe(5 + 10 + 1); // header + Lc + data + Le
  });

  it('handles empty Uint8Array as no data', () => {
    const apdu = buildApdu(CLA, 0x3c, 0x00, 0x00, new Uint8Array(0));
    expect(Array.from(apdu)).toEqual([CLA, 0x3c, 0x00, 0x00, 0x00]);
  });
});

// ── parseResponse ─────────────────────────────────────────────────────────────

describe('parseResponse', () => {
  it('parses a response with data', () => {
    const raw = new Uint8Array([0xaa, 0xbb, 0x90, 0x00]);
    const resp = parseResponse(raw);
    expect(resp.sw).toBe(0x9000);
    expect(Array.from(resp.data)).toEqual([0xaa, 0xbb]);
  });

  it('parses a status-only response (no data)', () => {
    const raw = new Uint8Array([0x6d, 0x00]);
    const resp = parseResponse(raw);
    expect(resp.sw).toBe(0x6d00);
    expect(resp.data.length).toBe(0);
  });

  it('throws on response shorter than 2 bytes', () => {
    expect(() => parseResponse(new Uint8Array([0x90]))).toThrow('Response too short');
    expect(() => parseResponse(new Uint8Array([]))).toThrow('Response too short');
  });

  it('correctly extracts SW from PIN failure responses', () => {
    const raw = new Uint8Array([0x63, 0xc2]);
    const resp = parseResponse(raw);
    expect(resp.sw).toBe(0x63c2);
  });
});

// ── sendApdu ──────────────────────────────────────────────────────────────────

describe('sendApdu', () => {
  it('sends a command and returns parsed response', async () => {
    const transport = mockTransport([0x01, 0x02, 0x90, 0x00]);
    const resp = await sendApdu(transport, 0x3c, 0x00, 0x00);
    expect(resp.sw).toBe(0x9000);
    expect(Array.from(resp.data)).toEqual([0x01, 0x02]);
    expect(transport.transmit).toHaveBeenCalledOnce();
  });

  it('uses CLA 0xB0 for all commands', async () => {
    const transport = mockTransport([0x90, 0x00]);
    await sendApdu(transport, 0x42, 0x00, 0x00);
    const sentCmd = (transport.transmit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentCmd[0]).toBe(CLA);
  });

  it('passes data through to the command', async () => {
    const transport = mockTransport([0x90, 0x00]);
    const data = new Uint8Array([0xaa, 0xbb]);
    await sendApdu(transport, 0x42, 0x00, 0x00, data);
    const sentCmd = (transport.transmit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentCmd[5]).toBe(0xaa);
    expect(sentCmd[6]).toBe(0xbb);
  });
});

// ── sendApduChecked ───────────────────────────────────────────────────────────

describe('sendApduChecked', () => {
  it('returns data on success (SW=9000)', async () => {
    const transport = mockTransport([0xde, 0xad, 0x90, 0x00]);
    const data = await sendApduChecked(transport, 0x3c, 0x00, 0x00);
    expect(Array.from(data)).toEqual([0xde, 0xad]);
  });

  it('throws CardError on non-9000 response', async () => {
    const transport = mockTransport([0x9c, 0x06]);
    await expect(sendApduChecked(transport, 0x42, 0x00, 0x00))
      .rejects.toThrow(CardError);
  });

  it('includes SW in CardError', async () => {
    const transport = mockTransport([0x9c, 0x14]);
    try {
      await sendApduChecked(transport, 0x6d, 0x00, 0x00);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CardError);
      expect((e as CardError).sw).toBe(0x9c14);
    }
  });

  it('allows custom expected SW', async () => {
    const transport = mockTransport([0xff, 0x00]);
    const data = await sendApduChecked(transport, 0xff, 0x00, 0x00, undefined, 0xff00);
    expect(data.length).toBe(0);
  });

  it('extracts triesRemaining from 0x63Cx PIN failure', async () => {
    const transport = mockTransport([0x63, 0xc3]);
    try {
      await sendApduChecked(transport, 0x42, 0x00, 0x00);
      expect.unreachable();
    } catch (e) {
      expect((e as CardError).sw).toBe(0x63c3);
      expect((e as CardError).triesRemaining).toBe(3);
    }
  });
});

// ── selectApplet ──────────────────────────────────────────────────────────────

describe('selectApplet', () => {
  it('sends ISO SELECT with the AID', async () => {
    const transport = mockTransport([0x90, 0x00]);
    const aid = new Uint8Array([0x53, 0x6f, 0x6c, 0x61, 0x6e, 0x61, 0x00]);
    await selectApplet(transport, aid);

    const cmd = (transport.transmit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(cmd[0]).toBe(0x00); // CLA
    expect(cmd[1]).toBe(0xa4); // INS SELECT
    expect(cmd[2]).toBe(0x04); // P1
    expect(cmd[3]).toBe(0x00); // P2
    expect(cmd[4]).toBe(7);    // Lc = AID length
    expect(Array.from(cmd.slice(5))).toEqual(Array.from(aid));
  });

  it('throws CardError on SELECT failure', async () => {
    const transport = mockTransport([0x6a, 0x82]);
    const aid = new Uint8Array([0x53, 0x6f, 0x6c]);
    await expect(selectApplet(transport, aid)).rejects.toThrow(CardError);
  });
});
