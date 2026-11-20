import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PASSKEY_USER_VERIFICATION } from '../src/passkey/passkey.policy.ts';

test('Passkey registration and authentication enforce the same user verification policy', () => {
  assert.equal(PASSKEY_USER_VERIFICATION.request, 'required');
  assert.equal(PASSKEY_USER_VERIFICATION.verify, true);
});

test('PasskeyService uses the required-UV policy for both registration and authentication', () => {
  const source = readFileSync(new URL('../src/passkey/passkey.service.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/userVerification:\s*PASSKEY_USER_VERIFICATION\.request/g) ?? []).length, 2);
  assert.equal((source.match(/requireUserVerification:\s*PASSKEY_USER_VERIFICATION\.verify/g) ?? []).length, 2);
});
