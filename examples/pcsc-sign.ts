#!/usr/bin/env ts-node
/**
 * Example: Connect to SolanaApplet via PC/SC, import seed, and sign a
 * Solana transfer on devnet.
 *
 * Usage:
 *   npx ts-node examples/pcsc-sign.ts "<bip39 mnemonic>" [--pin 1234]
 *
 * Requires: pcsclite, @solana/web3.js, bip39 (peer dependencies — not
 * included in the SDK itself).
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import * as bip39 from 'bip39';
import { SolanaCard, CardTransport, SOLANA_PATH } from '../src';

// ── PC/SC transport adapter ──────────────────────────────────────────────────

interface PcscReader {
  name: string;
  state: number;
  SCARD_STATE_PRESENT: number;
  SCARD_SHARE_SHARED: number;
  SCARD_LEAVE_CARD: number;
  connect(
    opts: { share_mode: number },
    cb: (err: Error | null, protocol: number) => void,
  ): void;
  transmit(
    data: Buffer,
    maxLen: number,
    protocol: number,
    cb: (err: Error | null, response: Buffer) => void,
  ): void;
  disconnect(disposition: number, cb: () => void): void;
  on(event: 'status', cb: (status: { state: number }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** CardTransport backed by the `pcsclite` npm package. */
class PcscTransport implements CardTransport {
  constructor(
    private reader: PcscReader,
    private protocol: number,
  ) {}

  transmit(command: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.reader.transmit(
        Buffer.from(command),
        4096,
        this.protocol,
        (err, data) => (err ? reject(err) : resolve(new Uint8Array(data))),
      );
    });
  }

  disconnect(): void {
    this.reader.disconnect(this.reader.SCARD_LEAVE_CARD, () => {});
  }

  static connect(timeoutMs = 30_000): Promise<PcscTransport> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pcsclite = require('pcsclite') as () => NodeJS.EventEmitter & {
      on(event: 'reader', cb: (reader: PcscReader) => void): void;
      on(event: 'error', cb: (err: Error) => void): void;
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No card detected after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const pcsc = pcsclite();

      pcsc.on('reader', (reader) => {
        console.log(`  Reader: ${reader.name}`);
        reader.on('status', (status) => {
          const changes = reader.state ^ status.state;
          if (changes & reader.SCARD_STATE_PRESENT && status.state & reader.SCARD_STATE_PRESENT) {
            reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, (err, protocol) => {
              clearTimeout(timeout);
              if (err) reject(err);
              else resolve(new PcscTransport(reader, protocol));
            });
          }
        });
        reader.on('error', (err) => { clearTimeout(timeout); reject(err); });
      });
      pcsc.on('error', (err) => { clearTimeout(timeout); reject(err); });

      console.log('  Waiting for card...');
    });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: npx ts-node examples/pcsc-sign.ts "<bip39 mnemonic>" [--pin <pin>]');
    process.exit(args[0] === '--help' ? 0 : 1);
  }

  const mnemonic = args[0];
  const pinIdx = args.indexOf('--pin');
  const pinStr = pinIdx >= 0 ? args[pinIdx + 1] : '1234';
  const pin = new TextEncoder().encode(pinStr);
  const puk = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x46]); // "ABCDEF"

  if (!bip39.validateMnemonic(mnemonic)) {
    console.error('ERROR: Invalid BIP-39 mnemonic');
    process.exit(1);
  }

  // 1. Derive seed
  console.log('\n-- Derive seed from mnemonic --');
  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  console.log(`  ${mnemonic.split(' ').length} words -> ${seed.length}-byte seed`);

  // 2. Connect
  console.log('\n-- Connect to card --');
  const transport = await PcscTransport.connect();
  const card = new SolanaCard(transport);

  // 3. Select applet
  await card.select();
  console.log('  SolanaApplet selected.');

  // 4. Setup if needed
  const status = await card.getStatus();
  console.log(`  setup=${status.setupDone}  seeded=${status.isSeeded}  pin_tries=${status.pinTriesLeft}`);

  if (!status.setupDone) {
    console.log('  Running first-time setup...');
    await card.setup(pin, puk);
  }

  // 5. Verify PIN
  await card.verifyPin(pin);
  console.log('  PIN verified.');

  // 6. Import seed or read existing pubkey
  let pubkeyBytes: Uint8Array;
  if (!status.isSeeded) {
    console.log('\n-- Import seed (~3s) --');
    const t0 = Date.now();
    pubkeyBytes = await card.importSeed(new Uint8Array(seed));
    console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.log('\n-- Read existing public key (~3s) --');
    const t0 = Date.now();
    pubkeyBytes = await card.getPublicKey(SOLANA_PATH);
    console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const address = new PublicKey(pubkeyBytes);
  console.log(`  Address: ${address.toBase58()}`);

  // 7. Solana devnet
  console.log('\n-- Solana devnet --');
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  let balance = await connection.getBalance(address);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.log('  Requesting airdrop (1 SOL)...');
    const sig = await connection.requestAirdrop(address, LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    balance = await connection.getBalance(address);
    console.log(`  New balance: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }

  // 8. Build transaction
  console.log('\n-- Build transfer --');
  const recipient = Keypair.generate();
  const transferAmount = await connection.getMinimumBalanceForRentExemption(0);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: address,
      toPubkey: recipient.publicKey,
      lamports: transferAmount,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = address;

  const messageBytes = tx.serializeMessage();
  console.log(`  To: ${recipient.publicKey.toBase58()} (throwaway)`);
  console.log(`  Amount: ${transferAmount} lamports`);
  console.log(`  Message: ${messageBytes.length} bytes`);

  // 9. Sign on card
  console.log('\n-- Sign on card (~4s) --');
  const t1 = Date.now();
  const sigBytes = await card.signTransaction(messageBytes);
  console.log(`  Signed in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  Signature: ${Buffer.from(sigBytes).toString('hex').slice(0, 32)}...`);

  // 10. Broadcast
  console.log('\n-- Broadcast --');
  tx.addSignature(address, Buffer.from(sigBytes));

  if (!tx.verifySignatures()) {
    throw new Error('Local signature verification failed');
  }
  console.log('  Signature verified locally.');

  const txSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`  Sent: ${txSig}`);

  await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, 'confirmed');
  const finalBalance = await connection.getBalance(address);
  console.log(`\n  Confirmed! Balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  Explorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet\n`);

  transport.disconnect();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
