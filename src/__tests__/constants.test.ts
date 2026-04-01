import { describe, it, expect } from 'vitest';
import { APPLET_AID, CLA, INS, SIGN_P1, SW, SOLANA_PATH } from '../constants';

describe('constants', () => {
  it('APPLET_AID spells "Solana\\0"', () => {
    const decoded = new TextDecoder().decode(APPLET_AID.slice(0, 6));
    expect(decoded).toBe('Solana');
    expect(APPLET_AID[6]).toBe(0x00);
    expect(APPLET_AID.length).toBe(7);
  });

  it('CLA is 0xB0', () => {
    expect(CLA).toBe(0xb0);
  });

  it('INS codes are distinct', () => {
    const values = Object.values(INS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('SIGN_P1 flags are correct', () => {
    expect(SIGN_P1.FIRST).toBe(0x01);
    expect(SIGN_P1.CONTINUATION).toBe(0x00);
    expect(SIGN_P1.LAST).toBe(0x80);
    expect(SIGN_P1.FIRST_LAST).toBe(0x81);
    // FIRST_LAST = FIRST | LAST
    expect(SIGN_P1.FIRST_LAST).toBe(SIGN_P1.FIRST | SIGN_P1.LAST);
  });

  it('SOLANA_PATH is m/44\'/501\'/0\' (all hardened)', () => {
    expect(SOLANA_PATH).toEqual([0x8000002c, 0x800001f5, 0x80000000]);
    // Each index has the hardened bit set (use >>> 0 to avoid signed int comparison)
    for (const idx of SOLANA_PATH) {
      expect((idx & 0x80000000) >>> 0).toBe(0x80000000);
    }
  });

  it('SW.OK is 0x9000', () => {
    expect(SW.OK).toBe(0x9000);
  });
});
