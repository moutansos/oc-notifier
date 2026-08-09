/**
 * Time-bounded "have we already handled this event?" tracker.
 *
 * A single request can reach us more than once — the v2 event and its legacy
 * twin, or a repeated part update. Callers reserve every key that identifies
 * the request (request id, tool call id); the first reservation wins and later
 * ones are rejected. Reservation is synchronous so it cannot be raced by two
 * handlers that both await session info before notifying.
 */

export class EventDeduper {
  private readonly ttlMs: number;
  /** key -> reservation timestamp (ms) */
  private readonly seen = new Map<string, number>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /**
   * Claim this event. Returns false when any key was already claimed within
   * the TTL; otherwise records every key and returns true.
   */
  reserve(keys: string[]): boolean {
    const now = Date.now();
    this.prune(now);

    for (const key of keys) {
      if (this.seen.has(key)) {
        return false;
      }
    }

    for (const key of keys) {
      this.seen.set(key, now);
    }

    return true;
  }

  /** Number of live reservations (exported for tests). */
  get size(): number {
    this.prune(Date.now());
    return this.seen.size;
  }

  prune(now: number = Date.now()): void {
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp >= this.ttlMs) {
        this.seen.delete(key);
      }
    }
  }
}

/** Keys identifying a question request across the v2 and legacy event paths. */
export function questionKeys(event: {
  id: string;
  sessionID: string;
  callID?: string;
}): string[] {
  const keys = [`question:${event.id}`];
  if (event.callID) {
    keys.push(`question:tool:${event.sessionID}:${event.callID}`);
  }
  return keys;
}

/** Keys identifying a permission request across the v2 and legacy event paths. */
export function permissionKeys(event: {
  id: string;
  sessionID: string;
  callID?: string;
}): string[] {
  const keys = [`permission:${event.id}`];
  if (event.callID) {
    keys.push(`permission:tool:${event.sessionID}:${event.callID}`);
  }
  return keys;
}
