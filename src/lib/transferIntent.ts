// Keeps one logical payment on one idempotency key across manual retries.
// The memo/description is deliberately excluded: editing only the memo must not
// turn a retry into a second payment.

export interface TransferIntent {
  key: string;
  fingerprint: string;
}

export function transferFingerprint(input: {
  from: string; // `${type}:${id}`
  to: string;
  amount: number;
  category: string;
}): string {
  return JSON.stringify([input.from, input.to, input.amount, input.category]);
}

export function resolveTransferIntent(
  previous: TransferIntent | null,
  fingerprint: string,
  makeKey: () => string
): TransferIntent {
  if (previous && previous.fingerprint === fingerprint) return previous;
  return { key: makeKey(), fingerprint };
}
