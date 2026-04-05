/**
 * PC/SC transport for e2e tests.
 * Requires `pcsclite` to be installed (devDependency).
 */
import { CardTransport } from '../src';

interface PcscReader {
  name: string;
  state: number;
  SCARD_STATE_PRESENT: number;
  SCARD_SHARE_SHARED: number;
  SCARD_LEAVE_CARD: number;
  connect(
    opts: { share_mode: number },
    cb: (err: Error | null, protocol: number) => void
  ): void;
  transmit(
    data: Buffer,
    maxLen: number,
    protocol: number,
    cb: (err: Error | null, response: Buffer) => void
  ): void;
  disconnect(disposition: number, cb: () => void): void;
  on(event: 'status', cb: (status: { state: number }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export class PcscTransport implements CardTransport {
  constructor(
    private reader: PcscReader,
    private protocol: number
  ) {}

  transmit(command: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.reader.transmit(
        Buffer.from(command),
        4096,
        this.protocol,
        (err, data) => (err ? reject(err) : resolve(new Uint8Array(data)))
      );
    });
  }

  disconnect(): void {
    this.reader.disconnect(this.reader.SCARD_LEAVE_CARD, () => {});
  }

  /**
   * Wait for a card to be presented and connect.
   * Rejects with a timeout error if no card is detected within `timeoutMs`.
   */
  static connect(timeoutMs = 30_000): Promise<PcscTransport> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pcsclite = require('pcsclite') as () => NodeJS.EventEmitter & {
      on(event: 'reader', cb: (reader: PcscReader) => void): void;
      on(event: 'error', cb: (err: Error) => void): void;
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No card detected after ${timeoutMs}ms`)),
        timeoutMs
      );
      const pcsc = pcsclite();

      pcsc.on('reader', (reader) => {
        reader.on('status', (status) => {
          const changes = reader.state ^ status.state;
          if (
            changes & reader.SCARD_STATE_PRESENT &&
            status.state & reader.SCARD_STATE_PRESENT
          ) {
            reader.connect(
              { share_mode: reader.SCARD_SHARE_SHARED },
              (err, protocol) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else resolve(new PcscTransport(reader, protocol));
              }
            );
          }
        });
        reader.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      pcsc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}
