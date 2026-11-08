function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message ?? '').toLowerCase();
  }
  return String(err ?? '').toLowerCase();
}

export function isConnectionRefusedError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes('winerror 10061')
    || message.includes('connection refused')
    || message.includes('zielcomputer die verbindung verweigerte')
  );
}
