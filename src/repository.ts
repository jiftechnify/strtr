import assert from "node:assert";

import { Heap } from "heap-js";
import type { NostrEvent } from "nostr-tools/core";
import { type Filter, matchFilter } from "nostr-tools/filter";

import { getEventHandling, getTagValuesByName } from "./event";
import { isNeverMatchingFilter } from "./filter";
import type { EventRepositoryInsertionError, IEventRepository } from "./interfaces";
import { Result } from "./types";

type EventIndices = {
	author: EventIndex<string>;
	kind: EventIndex<number>;
	eTag: EventIndex<string>;
	pTag: EventIndex<string>;
};

export class EventRepository implements IEventRepository {
	#eventsById = new Map<string, ManagedEvent>();

	#allEventsSorted = EventBucket.empty("all");
	#indices: EventIndices = {
		author: new EventIndex("author", (ev) => [ev.pubkey]),
		kind: new EventIndex("kind", (ev) => [ev.kind]),
		eTag: new EventIndex("eTag", (ev) => getTagValuesByName(ev, "e")),
		pTag: new EventIndex("pTag", (ev) => getTagValuesByName(ev, "p")),
	};
	#reTracker = new ReplaceableEventTracker();
	#deletedEvents = new Set<string>();

	// preconditions:
	// - event syntax is valid
	// - event signature is valid
	// - event semantics are valid
	// - event is not ephemeral
	insert(ev: NostrEvent): Result<object, EventRepositoryInsertionError> {
		const evHandling = getEventHandling(ev);
		assert(evHandling !== "ephemeral", "ephemeral event should not be inserted to repository");

		if (this.#eventsById.has(ev.id)) {
			console.log(`[EventRepository] event (id: ${ev.id}) is already stored`);
			return Result.err("duplicated");
		}
		if (this.#deletedEvents.has(ev.id)) {
			console.log(`[EventRepository] event (id: ${ev.id}) is already deleted`);
			return Result.err("deleted");
		}

		console.log(`[EventRepository] inserting event (id: ${ev.id}, author: ${ev.pubkey}, created_at: ${ev.created_at})`);

		// special handling of kind 5: delete event referenced by it
		if (ev.kind === 5) {
			console.log(`[EventRepository] storing new deletion event (id: ${ev.id})`);
			this.#store(ev);

			for (const e of getTagValuesByName(ev, "e")) {
				const deleted = this.#deleteById(e, ev.pubkey);
				if (deleted) {
					this.#deletedEvents.add(e); // record the id of deleted event so that it won't be stored again
				}
			}
			for (const a of getTagValuesByName(ev, "a")) {
				this.#deleteByAddr(a, ev.pubkey);
			}
			return Result.ok({});
		}

		// replaceable events
		if (evHandling === "non-param-replaceable" || evHandling === "param-replaceable") {
			const { addr, overwritten, toBeStored } = this.#reTracker.replace(ev);
			if (toBeStored !== undefined) {
				console.log(`[EventRepository] storing new replaceable event (addr: ${addr}, id: ${ev.id}`);
				this.#store(toBeStored);
			}
			if (overwritten !== undefined) {
				console.log(
					`[EventRepository] replaceable: deleting overwritten replaceable event (addr: ${addr}, id: ${ev.id})`,
				);
				this.#deleteById(overwritten.id, ev.pubkey); // by definition of replaceable event, "deletion requester" is always the author
			}
			return Result.ok({});
		}

		// regular events
		console.log(`[EventRepository] regular: storing new event (id: ${ev.id})`);
		this.#store(ev);

		return Result.ok({});
	}

	#store(ev: NostrEvent): void {
		// make sure that you store the same reference to all indices!
		const mev = new ManagedEvent(ev);

		this.#eventsById.set(ev.id, mev);

		this.#allEventsSorted.insert(mev);

		this.#indices.author.insert(mev);
		this.#indices.kind.insert(mev);
		this.#indices.eTag.insert(mev);
		this.#indices.pTag.insert(mev);
	}

	#deleteById(id: string, requester: string): boolean {
		console.log(`[EventRepository] deleting event by id (id: ${id})`);
		const targ = this.#eventsById.get(id);
		if (targ === undefined) {
			console.log(`[EventRepository] not found event to delete (id: ${id})`);
			return false;
		}
		if (requester !== targ.event.pubkey) {
			console.log(`[EventRepository] requester of deletion is not the author of the event (id: ${id})`);
			return false;
		}
		if (targ.event.kind === 5) {
			console.log(`[EventRepository] can't delete deletion event (id: ${id})`);
			return false;
		}
		// flag deletion
		targ.delete();
		return true;
	}

	#deleteByAddr(addr: string, requester: string): void {
		console.log(`[EventRepository] deleting event by address of replaceable event (addr: ${addr})`);
		const deletedEv = this.#reTracker.delete(addr);
		if (deletedEv === undefined) {
			console.log(`[EventRepository] not found event to delete (addr: ${addr})`);
			return;
		}
		if (requester !== deletedEv.pubkey) {
			console.log(`[EventRepository] requester of deletion is not the author of the event (addr: ${addr})`);
			return;
		}
		// flag deletion
		this.#deleteById(deletedEv.id, requester);
	}

	*query(filters: Filter[]): IterableIterator<NostrEvent> {
		console.log(`[EventRepository] querying event (filters: ${JSON.stringify(filters)})`);

		for (const filter of filters) {
			if (filter.limit === 0) {
				console.log(`[EventRepository] skipping filter with limit: 0 (filter: ${JSON.stringify(filter)})`);
				continue;
			}
			if (isNeverMatchingFilter(filter)) {
				console.log(`[EventRepository] skipping never matching filter (filter: ${JSON.stringify(filter)})`);
				continue;
			}

			const lim = Math.min(filter.limit ?? 500, 500);
			const buckets = this.#selectIndex(filter);
			if (buckets.length === 0) {
				continue;
			}
			if (buckets.length === 1) {
				// biome-ignore lint/style/noNonNullAssertion: `buckets[0]` should be defined
				yield* take(buckets[0]!.query(filter), lim);
				continue;
			}
			// yield events from multiple buckets
			yield* take(this.#mergedBuckets(buckets, filter), lim);
		}

		console.log(`[EventRepository] query done (filters: ${JSON.stringify(filters)})`);
	}

	#selectIndex(filter: Filter): EventBucket[] {
		if (filter.ids !== undefined) {
			return [this.#allEventsSorted];
		}

		const a = this.#indices.author.getCandidateBuckets(filter.authors);
		const k = this.#indices.kind.getCandidateBuckets(filter.kinds);
		const e = this.#indices.eTag.getCandidateBuckets(filter["#e"]);
		const p = this.#indices.pTag.getCandidateBuckets(filter["#p"]);

		const { buckets } = [a, k, e, p]
			.filter((bs): bs is CandidateBuckets => bs !== undefined)
			.reduce(
				(min, cand) => {
					if (cand.totalSize < min.totalSize) {
						return cand;
					}
					if (cand.totalSize === min.totalSize && cand.buckets.length < min.buckets.length) {
						return cand;
					}
					return min;
				},
				{ buckets: [this.#allEventsSorted], totalSize: this.#allEventsSorted.size },
			);
		return buckets;
	}

	*#mergedBuckets(buckets: EventBucket[], filter: Filter): IterableIterator<NostrEvent> {
		const iterMap = new Map<string, Iterator<NostrEvent>>(buckets.map((b) => [b.id, b.query(filter)]));

		// a priority queue that has latest events from each bucket. the top of the queue is always the latest event.
		const nextQueue = new Heap<{ bucketId: string; ev: NostrEvent }>(
			(a, b) => -compareNostrEvents(a.ev, b.ev), // latest first
		);
		// set of event ids that have been yielded (for dedup)
		const yieldedIds = new Set<string>();

		for (const [bucketId, iter] of iterMap) {
			const next = iter.next();
			if (!next.done) {
				nextQueue.push({ bucketId, ev: next.value });
			}
		}
		while (nextQueue.length > 0) {
			// biome-ignore lint/style/noNonNullAssertion: `nextQueue` is always non-empty
			const { bucketId, ev } = nextQueue.pop()!;

			if (!yieldedIds.has(ev.id)) {
				yield ev;
				yieldedIds.add(ev.id);
			}

			// biome-ignore lint/style/noNonNullAssertion: `bucketId` is always in `iterMap`
			const nx = iterMap.get(bucketId)!.next();
			if (!nx.done) {
				nextQueue.push({ bucketId, ev: nx.value });
			}
		}
	}
}

function* take<T>(iter: Iterable<T>, n: number): IterableIterator<T> {
	if (n <= 0) {
		return;
	}

	let i = 0;
	for (const v of iter) {
		yield v;
		i++;
		if (i >= n) {
			break;
		}
	}
}

class ManagedEvent {
	private deleted = false;
	constructor(private ev: NostrEvent) {}

	get event(): NostrEvent {
		return this.ev;
	}
	get isDeleted(): boolean {
		return this.deleted;
	}
	delete() {
		this.deleted = true;
	}
}

class EventBucket {
	// events are sorted in ascending order of created_at (old <-> new)
	// because, generally speaking, push(append) is faster than unshift(prepend)
	private events: ManagedEvent[] = [];

	private constructor(readonly id: string) {}

	// smart constructors
	static empty(id: string) {
		return new EventBucket(id);
	}
	static single(id: string, mev: ManagedEvent) {
		const b = new EventBucket(id);
		b.events.push(mev);
		return b;
	}

	get size(): number {
		return this.events.length;
	}

	// most of time events arrive in chronological order, so insertion sort should be efficient enough
	insert(mev: ManagedEvent): void {
		this.events.push(mev);
		for (let i = this.events.length - 1; i > 0; i--) {
			// biome-ignore lint/style/noNonNullAssertion: `i` and `i-1` always within bounds
			const [e1, e2] = [this.events[i - 1]!, this.events[i]!];
			if (compareNostrEvents(e1.event, e2.event) <= 0) {
				break;
			}
			this.events[i] = e1;
			this.events[i - 1] = e2;
		}
	}

	// yield events that match the filter in descending order of created_at (new -> old)
	*query(filter: Filter): IterableIterator<NostrEvent> {
		const s = filter.until === undefined ? this.events.length - 1 : this.searchStartIndex(filter.until);
		for (let i = s; i >= 0; i--) {
			// biome-ignore lint/style/noNonNullAssertion: `i` always within bounds
			const ent = this.events[i]!;
			if (filter.since !== undefined && ent.event.created_at < filter.since) {
				break;
			}
			if (!ent.isDeleted && matchFilter(filter, ent.event)) {
				yield ent.event;
			}
		}
	}

	private searchStartIndex(until: number): number {
		let [l, r] = [0, this.events.length - 1];
		while (true) {
			if (l >= r) {
				// biome-ignore lint/style/noNonNullAssertion: `l` always within bounds
				const created_at = this.events[l]!.event.created_at;
				return until >= created_at ? l : l - 1;
			}

			const m = Math.floor((l + r) / 2);

			// biome-ignore lint/style/noNonNullAssertion: `m` always within bounds
			const created_at = this.events[m]!.event.created_at;

			if (until === created_at) {
				return m;
			}

			if (until < created_at) {
				r = m - 1;
			} else {
				l = m + 1;
			}
		}
	}
}

type CandidateBuckets = {
	buckets: EventBucket[];
	totalSize: number;
};

class EventIndex<K extends string | number> {
	private buckets = new Map<K, EventBucket>();

	constructor(
		private keyName: string,
		private getKeys: (ev: NostrEvent) => K[],
	) {}

	private bucketId(key: K) {
		return `${this.keyName}/${key}`;
	}

	insert(mev: ManagedEvent): void {
		const keys = this.getKeys(mev.event);
		for (const key of keys) {
			const bucket = this.buckets.get(key);
			if (bucket === undefined) {
				this.buckets.set(key, EventBucket.single(this.bucketId(key), mev));
				return;
			}
			bucket.insert(mev);
		}
	}

	getCandidateBuckets(keys?: K[]): CandidateBuckets | undefined {
		if (keys === undefined) {
			return undefined;
		}
		const buckets = keys.map((k) => this.buckets.get(k)).filter((b): b is EventBucket => b !== undefined);
		const totalSize = buckets.map((b) => b.size).reduce((sum, n) => sum + n, 0);
		return { buckets, totalSize };
	}
}

type ReplaceOutcome = { addr: string; overwritten: NostrEvent | undefined; toBeStored: NostrEvent | undefined };

class ReplaceableEventTracker {
	private entries = new Map<string, NostrEvent>();

	// pre-conditions:
	// - received is a "fresh" event
	// - received is a replaceable event
	// - for parametarized one, it has a d-tag
	replace(received: NostrEvent): ReplaceOutcome {
		const addr = replaceableEventAddr(received);
		const existing = this.entries.get(addr);

		if (existing === undefined) {
			this.entries.set(addr, received);
			return { addr, overwritten: undefined, toBeStored: received };
		}
		if (compareNostrEvents(received, existing) > 0) {
			// received is newer: replace it
			this.entries.set(addr, received);
			return { addr, overwritten: existing, toBeStored: received };
		}
		// existing is newer: retain it
		return { addr, overwritten: undefined, toBeStored: undefined };
	}

	delete(addr: string): NostrEvent | undefined {
		const existing = this.entries.get(addr);
		if (existing === undefined) {
			return undefined;
		}
		this.entries.delete(addr);
		return existing;
	}
}

const replaceableEventAddr = (ev: NostrEvent): string => {
	switch (getEventHandling(ev)) {
		case "non-param-replaceable":
			return `${ev.kind}:${ev.pubkey}:`;
		case "param-replaceable": {
			const d = getTagValuesByName(ev, "d")[0];
			if (d === undefined) {
				throw Error("replaceableEventAddr: param-replaceable event doesn't have d-tag (unreachable)");
			}
			return `${ev.kind}:${ev.pubkey}:${d}`;
		}
		default:
			throw Error("replaceableEventAddr: event is not replaceable (unreachable)");
	}
};

// returns whether e1 should be sorted before or after e2.
// - negative ... e1 should be sorted before e2, or e1 is "older" than e2
// - positive ... e1 should be sorted after e2, or e1 is "newer" than e2
// - 0        ... e1 and e2 are the same event
const compareNostrEvents = (e1: NostrEvent, e2: NostrEvent): number => {
	const caDiff = e1.created_at - e2.created_at;
	if (caDiff !== 0) {
		return caDiff;
	}

	// NIP-01: In case of replaceable events with the same timestamp,
	// the event with the lowest id (first in lexical order) should be retained, and the other discarded.
	//
	// "should be retained" == "should be sorted after"
	if (e1.id < e2.id) {
		return 1;
	}
	if (e1.id > e2.id) {
		return -1;
	}
	return 0;
};
