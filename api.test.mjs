// Run: node api.test.mjs
import assert from 'node:assert/strict';
import handler, { parseArray } from './api/brief.mjs';

const call = async req => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body: {}, ...req }, res);
  return res;
};

assert.equal((await call({ method: 'GET' })).code, 405);
const anon = await call({ body: { prompt: 'hi' } });
assert.equal(anon.code, 403, 'no sign-in, no AI: the key is only spent for Editors');
assert.equal(anon.body.code, 'not_granted', 'the page reads this code and hides the AI briefs');
assert.equal((await call({ headers: { authorization: 'Basic abc' }, body: { prompt: 'hi' } })).code, 403);

assert.deepEqual(parseArray('Here you go:\n[{"sku":"A"}]\nDone.'), [{ sku: 'A' }]);
assert.equal(parseArray('{"sku":"A"}'), null, 'an object is not the array of briefs');
assert.equal(parseArray('[{"sku":'), null, 'a cut-off reply is refused');
console.log('api tests passed');
