// ── Applet identity ──────────────────────────────────────────────────────────
export const APPLET_AID = new Uint8Array([0x53, 0x6f, 0x6c, 0x61, 0x6e, 0x61, 0x00]);
export const CLA = 0xb0;

// ── INS codes ────────────────────────────────────────────────────────────────
export const INS = {
  SETUP:                  0x2a,
  GET_STATUS:             0x3c,
  CARD_LABEL:             0x3d,
  VERIFY_PIN:             0x42,
  CHANGE_PIN:             0x44,
  UNBLOCK_PIN:            0x46,
  IMPORT_SEED:            0x6c,
  GET_PUBLIC_KEY:         0x6d,
  SIGN_TX:                0x6f,
  EXPORT_AUTHENTIKEY:     0x73,
  RESET_SEED:             0x77,
  INIT_SECURE_CHANNEL:    0x81,
  PROCESS_SECURE_CHANNEL: 0x82,
  RESET_TO_FACTORY:       0xff,
} as const;

// ── P1 flags for INS_SIGN_TX ─────────────────────────────────────────────────
export const SIGN_P1 = {
  FIRST:       0x01,
  CONTINUATION:0x00,
  LAST:        0x80,
  FIRST_LAST:  0x81,
} as const;

// ── Status words ─────────────────────────────────────────────────────────────
export const SW = {
  OK:                         0x9000,
  RESET_TO_FACTORY:           0xff00,
  PIN_FAILED:                 0x63c0, // | tries_left in low nibble
  SETUP_ALREADY_DONE:         0x9c03,
  SETUP_NOT_DONE:             0x9c04,
  UNSUPPORTED_FEATURE:        0x9c05,
  UNAUTHORIZED:               0x9c06,
  IDENTITY_BLOCKED:           0x9c0c,
  INVALID_PARAMETER:          0x9c0f,
  SEED_NOT_IMPORTED:          0x9c14,
  NOT_IMPLEMENTED:            0x9c20,
  SC_UNINITIALIZED:           0x9c21,
  SC_REQUIRED:                0x9c22,
  SC_WRONG_MAC:               0x9c23,
  SC_WRONG_IV:                0x9c24,
} as const;

// ── Default Solana BIP-44 path: m/44'/501'/0' ────────────────────────────────
export const SOLANA_PATH = [0x8000002c, 0x800001f5, 0x80000000] as const;

// ── Limits ───────────────────────────────────────────────────────────────────
export const PIN_MIN_SIZE = 4;
export const PIN_MAX_SIZE = 16;
export const LABEL_MAX_SIZE = 64;
export const MAX_TX_MESSAGE_SIZE = 1200;
export const APDU_DATA_MAX = 255;
export const SIGN_CHUNK_SIZE = 50;
