import { describe, it, expect } from 'vitest';
import { CardError } from '../types';

describe('CardError', () => {
  it('stores the status word', () => {
    const err = new CardError('test', 0x9c06);
    expect(err.sw).toBe(0x9c06);
    expect(err.name).toBe('CardError');
    expect(err.message).toBe('test');
  });

  it('extracts triesRemaining from 0x63Cx responses', () => {
    expect(new CardError('pin', 0x63c5).triesRemaining).toBe(5);
    expect(new CardError('pin', 0x63c0).triesRemaining).toBe(0);
    expect(new CardError('pin', 0x63cf).triesRemaining).toBe(15);
  });

  it('does not set triesRemaining for non-PIN errors', () => {
    expect(new CardError('err', 0x9c06).triesRemaining).toBeUndefined();
    expect(new CardError('err', 0x9000).triesRemaining).toBeUndefined();
    expect(new CardError('err', 0x6d00).triesRemaining).toBeUndefined();
  });

  it('is an instance of Error', () => {
    const err = new CardError('msg', 0x9c14);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CardError);
  });
});
