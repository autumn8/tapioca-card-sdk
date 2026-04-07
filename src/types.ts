/**
 * Transport interface — implement this for your platform (PC/SC, NFC, etc.).
 *
 * The SDK never touches NFC or PC/SC directly. You provide a transport that
 * can send raw byte arrays to the card and receive raw byte arrays back.
 */
export interface CardTransport {
  /**
   * Send a raw APDU command and return the full response (data + SW1 SW2).
   * The implementation must handle framing (e.g., ISO 14443-4 chaining).
   */
  transmit(command: Uint8Array): Promise<Uint8Array>;
}

/** Parsed response from a card APDU. */
export interface ApduResponse {
  /** Response data bytes (everything except the final 2-byte status word). */
  data: Uint8Array;
  /** 2-byte status word as a single number (e.g., 0x9000). */
  sw: number;
}

/** Card status returned by INS_GET_STATUS. */
export interface CardStatus {
  protocolMajor: number;
  protocolMinor: number;
  appletMajor: number;
  appletMinor: number;
  pinTriesLeft: number;
  pinTriesMax: number;
  pukTriesLeft: number;
  pukTriesMax: number;
  isSeeded: boolean;
  secureChannelActive: boolean;
  setupDone: boolean;
}

/** Result returned by signTransaction. */
export interface SignResult {
  /** 64-byte Ed25519 signature. */
  signature: Uint8Array;
  /** 32-byte Ed25519 public key at m/44'/501'/0'. */
  publicKey: Uint8Array;
}

/** Result of a secure channel handshake. */
export interface HandshakeResult {
  /** 32-byte X-coordinate of the card's ephemeral SECP256K1 public key. */
  ephemeralCoordX: Uint8Array;
  /** DER-encoded ECDSA-SHA256 self-signature (ephemeral key signs coordX). */
  sig1: Uint8Array;
  /** DER-encoded ECDSA-SHA256 authentikey cross-signature. */
  sig2: Uint8Array;
  /** 16-byte AES-128 session key (for reference — managed internally). */
  sessionKey: Uint8Array;
  /** 20-byte HMAC-SHA1 MAC key (for reference — managed internally). */
  macKey: Uint8Array;
}

/** Error thrown when the card returns an unexpected status word. */
export class CardError extends Error {
  /** The raw 2-byte status word. */
  readonly sw: number;
  /** Remaining PIN/PUK tries (only meaningful for 0x63Cx responses). */
  readonly triesRemaining?: number;

  constructor(message: string, sw: number) {
    super(message);
    this.name = 'CardError';
    this.sw = sw;
    if ((sw & 0xfff0) === 0x63c0) {
      this.triesRemaining = sw & 0x0f;
    }
  }
}
