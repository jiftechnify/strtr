import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { R2CMessageSender } from "./message";
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

export interface IEventIngestor {
	ingest(ev: NostrEvent, msgSender: R2CMessageSender): void;
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
