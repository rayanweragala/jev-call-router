export type RouterEventName =
  | "call.started"
  | "call.speaking"
  | "call.thinking"
  | "call.routed"
  | "call.fallback"
  | "call.ended";

export interface RouterEvent {
  event: RouterEventName;
  data: Record<string, unknown>;
  timestamp: string;
}

export type EventListener = (event: RouterEvent) => void;

class EventHub {
  private listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RouterEventName, data: Record<string, unknown>): void {
    const payload: RouterEvent = {
      event,
      data,
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export const eventHub = new EventHub();
