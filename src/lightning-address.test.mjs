import test from 'node:test';
import assert from 'node:assert/strict';
import { lightningAddress } from './lightning-address.js';

const pubkey = 'a'.repeat(64);
const address = 'member@satlantis.io';
const request = new Request('https://buildinelsalvador.com/.well-known/lnurlp/mike');
const metadata = JSON.stringify([['text/plain','Payment'], ['text/identifier',address]]);
const pay = { tag:'payRequest', callback:'https://api.satlantis.io/ln/callback', minSendable:1000, maxSendable:100000, metadata };
const store = entry => ({ SITE: { get: async key => key === 'lightning:alias:mike' ? entry : null } });
test('a verified, configured alias preserves the provider metadata and invoice callback', async t => {
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).includes('nostr.json') ? { names:{mike:pubkey} } : pay));
  const response = await lightningAddress(request, store({pubkey, address}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), pay);
});
test('unassigned, reassigned and mismatched payees never supply a callback', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ names:{mike:'b'.repeat(64)} }));
  assert.equal((await lightningAddress(request, store(null))).status, 404);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await lightningAddress(request, store({pubkey,address}))).status, 404);
  fetch.mock.mockImplementation(async url => Response.json(String(url).includes('nostr.json') ? {names:{mike:pubkey}} : {...pay,metadata:'[["text/plain","Payment"],["text/identifier","other@satlantis.io"]]'}));
  assert.equal((await lightningAddress(request, store({pubkey,address}))).status, 404);
});
