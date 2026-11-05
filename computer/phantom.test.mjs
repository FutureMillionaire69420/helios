import test from 'node:test';
import assert from 'node:assert/strict';
import {loadKeypair, b58decode, b58encode} from './copybot.mjs';

const seed = Buffer.alloc(32, 42);
const keyText = JSON.stringify([...seed]);

test('Phantom-exported Solana key derives a stable public address', () => {
  const kp = loadKeypair(keyText);
  assert.match(kp.publicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(b58decode(b58encode(b58decode(kp.publicKey))).length, 32);
});

test('base58 Solana private key format is accepted', () => {
  const kp1 = loadKeypair(keyText);
  const base58Seed = b58encode(seed);
  const kp2 = loadKeypair(base58Seed);
  assert.equal(kp2.publicKey, kp1.publicKey);
});
