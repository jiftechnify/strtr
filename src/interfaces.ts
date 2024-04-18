import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { Result } from "./types";

export type ConnectionCloser = "client" | "server";

export interface IConnection {
  close(closer: ConnectionCloser): void;
}

export interface ISubscription {
  readonly peerId: string;
  readonly subId: string;

  broadcast(ev: NostrEvent): void;
}

export interface ISubscriptionPool {
  register(sub: ISubscription): void;
  unregister(peerId: string, subId: string): void;

  broadcast(ev: NostrEvent): void;
}

export type EventIngestionOutcome = {
  ok: boolean;
  msg: string;
};

export interface IEventIngestor {
  ingest(ev: NostrEvent): EventIngestionOutcome;
}

export type EventRepositoryInsertionError = "duplicated" | "deleted";

export interface IEventRepository {
  insert(ev: NostrEvent): Result<object, EventRepositoryInsertionError>;
  query(filters: Filter[]): IterableIterator<NostrEvent>;
}

// FIXME: moar good name?
export type ServiceBundle = {
  repo: IEventRepository;
  subPool: ISubscriptionPool;
  ingestor: IEventIngestor;
};
