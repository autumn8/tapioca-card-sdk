import { CLA } from './constants';
import { ApduResponse, CardError, CardTransport } from './types';

/** Build a raw command APDU. */
export function buildApdu(
  cla: number,
  ins: number,
  p1: number,
  p2: number,
  data?: Uint8Array,
): Uint8Array {
  if (data && data.length > 0) {
    const cmd = new Uint8Array(5 + data.length + 1);
    cmd[0] = cla;
    cmd[1] = ins;
    cmd[2] = p1;
    cmd[3] = p2;
    cmd[4] = data.length;
    cmd.set(data, 5);
    cmd[5 + data.length] = 0x00; // Le
    return cmd;
  }
  return new Uint8Array([cla, ins, p1, p2, 0x00]);
}

/** Parse a raw response into data + status word. */
export function parseResponse(raw: Uint8Array): ApduResponse {
  if (raw.length < 2) throw new Error('Response too short');
  return {
    data: raw.slice(0, raw.length - 2),
    sw: (raw[raw.length - 2] << 8) | raw[raw.length - 1],
  };
}

/** Send an APDU and return parsed response. */
export async function sendApdu(
  transport: CardTransport,
  ins: number,
  p1: number,
  p2: number,
  data?: Uint8Array,
): Promise<ApduResponse> {
  const cmd = buildApdu(CLA, ins, p1, p2, data);
  const raw = await transport.transmit(cmd);
  return parseResponse(raw);
}

/** Send an APDU; throw CardError if SW !== expected. */
export async function sendApduChecked(
  transport: CardTransport,
  ins: number,
  p1: number,
  p2: number,
  data?: Uint8Array,
  expectedSw = 0x9000,
): Promise<Uint8Array> {
  const resp = await sendApdu(transport, ins, p1, p2, data);
  if (resp.sw !== expectedSw) {
    throw new CardError(
      `INS 0x${ins.toString(16)} failed: SW=${resp.sw.toString(16).toUpperCase().padStart(4, '0')}`,
      resp.sw,
    );
  }
  return resp.data;
}

/** SELECT the SolanaApplet by AID. */
export async function selectApplet(
  transport: CardTransport,
  aid: Uint8Array,
): Promise<void> {
  const cmd = new Uint8Array(5 + aid.length);
  cmd[0] = 0x00; // CLA for ISO SELECT
  cmd[1] = 0xa4;
  cmd[2] = 0x04;
  cmd[3] = 0x00;
  cmd[4] = aid.length;
  cmd.set(aid, 5);
  const raw = await transport.transmit(cmd);
  const resp = parseResponse(raw);
  if (resp.sw !== 0x9000) {
    throw new CardError(`SELECT failed`, resp.sw);
  }
}
