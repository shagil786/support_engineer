/** Minimal typed pub/sub used by the agent. */

export type Listener<T> = (payload: T) => void;

export class TypedEmitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<unknown>);
    return () => {
      set.delete(fn as Listener<unknown>);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      (fn as Listener<Events[K]>)(payload);
    }
  }
}