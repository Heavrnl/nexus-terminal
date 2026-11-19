/**
 * Registration and authentication both require user verification (UV).
 * Requesting only "preferred" while enforcing verification can make a
 * passkey provider return credentials that the server later rejects.
 */
export const PASSKEY_USER_VERIFICATION = {
  request: 'required',
  verify: true,
} as const;
