import type { Event as NostrEvent } from "nostr-tools/core";
import { type Filter, matchFilters } from "nostr-tools/filter";
import { verifyEvent } from "nostr-tools/pure";
import { type WebSocket, WebSocketServer } from "ws";

import { getEventHandling, validateEventSemantics } from "./event";
import { isNeverMatchingFilter } from "./filter";
import type {
	ConnectionCloser,
	EventIngestionOutcome,
	IConnection,
	IEventIngestor,
	IEventRepository,
	ISubscription,
	ISubscriptionPool,
	ServiceBundle,
} from "./interfaces";
import { type R2CMessageSender, createR2CMessageSender, parseC2RMessage } from "./message";
import { EventRepository } from "./repository";

export type RelayOptions = {
	host?: string;
	port?: number;
};

const defaultRelayOptions: Required<RelayOptions> = {
	host: "127.0.0.1",
	port: 5454,
};

/**
 * Launches a Nostr relay.
 *
 * @example
 * import { launchRelay } from 'strtr';
 * const shutdown = launchRelay();
 */
export const launchRelay = (opts: RelayOptions = {}) => {
	const options = { ...defaultRelayOptions, ...opts };

	const conns = new Set<IConnection>();

	const repo = new EventRepository();
	const subPool = new SubscriptionPool();
	const ingestor = new EventIngestor(repo, subPool);
	const services: ServiceBundle = {
		repo,
		subPool,
		ingestor,
	};

	const wsServer = new WebSocketServer({ host: options.host, port: options.port });
	wsServer.on("listening", () => {
		console.log(`[WSServer] listening on ${options.host}:${options.port}`);
	});
	wsServer.on("connection", (ws, req) => {
		const peerId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
		console.log(`[WSServer] new connection from ${peerId}`);

		const conn = new Connection(ws, peerId, services);
		conns.add(conn);

		ws.on("error", () => {
			console.error(`[WSServer] WebSocket error on ${peerId}`);
		});
		ws.once("close", (code) => {
			console.log(`[WSServer] socket closed (code: ${code})`);
			conn.close("client");
			conns.delete(conn);
		});
	});

	// shutdown function
	let shuttingDown = false;
	return () => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		console.log("[WSServer] shutting down...");
		for (const conn of conns) {
			conn.close("server");
		}
		conns.clear();
		wsServer.close();
	};
};

class Connection implements IConnection {
	#ws: WebSocket;
	#peerId: string;

	#services: ServiceBundle;

	#activeSubs = new Set<string>();

	constructor(ws: WebSocket, peerId: string, services: ServiceBundle) {
		this.#ws = ws;
		this.#peerId = peerId;
		this.#services = services;

		const r2cMsgSender = createR2CMessageSender(ws);

		ws.on("message", (data) => {
			console.log(`WebSocket message from ${this.#peerId}`);

			const rawMsg = data.toString("utf-8");
			const parseResult = parseC2RMessage(rawMsg);

			if (parseResult.ok) {
				const msg = parseResult.val;
				switch (msg[0]) {
					case "EVENT": {
						const ev = msg[1];

						const { ok: isOk, msg: okMsg } = this.#services.ingestor.ingest(ev);
						r2cMsgSender.sendOk(ev.id, isOk, okMsg);
						break;
					}
					case "REQ": {
						const subId = msg[1];
						const filters = msg.slice(2) as Filter[];

						// TODO: how to handle events that are ingested by another clients while querying?
						for (const ev of this.#services.repo.query(filters)) {
							r2cMsgSender.sendEvent(subId, ev);
						}
						r2cMsgSender.sendEose(subId);

						const effFilters = filters.filter((f) => !isNeverMatchingFilter(f));
						if (effFilters.length === 0) {
							r2cMsgSender.sendClosed(subId, "error: no effective filter");
							return;
						}
						const sub = new Subscription(this.#peerId, subId, effFilters, r2cMsgSender);
						this.#services.subPool.register(sub);
						this.#activeSubs.add(subId);
						break;
					}
					case "CLOSE": {
						const subId = msg[1];

						if (this.#activeSubs.has(subId)) {
							this.#services.subPool.unregister(this.#peerId, subId);
							this.#activeSubs.delete(subId);
							console.log(`[Connection] closed subscription (peer: ${this.#peerId}, subId: ${subId})`);
						}
						break;
					}
					default: {
						console.error("unknown message type (unreachable)");
						break;
					}
				}
			} else {
				switch (parseResult.err.errType) {
					case "malformed": {
						console.log(`malformed message: ${rawMsg}`);
						r2cMsgSender.sendNotice(`malformed message: ${rawMsg}`);
						break;
					}
					case "unsupported": {
						console.log(`unsupported message type: ${parseResult.err.msgType}`);
						r2cMsgSender.sendNotice(`unsupported message type: ${parseResult.err.msgType}`);
						break;
					}
				}
			}
		});
	}

	close(closer: ConnectionCloser): void {
		for (const subId of this.#activeSubs) {
			this.#services.subPool.unregister(this.#peerId, subId);
		}
		if (closer === "server") {
			console.log("[Connection] closing by server...");
			this.#ws.close();
		}
	}
}

class Subscription implements ISubscription {
	#peerId: string;
	#subId: string;
	#filters: Filter[];
	#msgSender: R2CMessageSender;

	get peerId(): string {
		return this.#peerId;
	}

	get subId(): string {
		return this.#subId;
	}

	constructor(peerId: string, subId: string, filters: Filter[], msgSender: R2CMessageSender) {
		this.#peerId = peerId;
		this.#subId = subId;
		this.#filters = filters;
		this.#msgSender = msgSender;
	}

	broadcast(ev: NostrEvent): void {
		console.log(`[Subscription] broadcasting event (peer: ${this.#peerId}, subId: ${this.#subId})...`);

		if (matchFilters(this.#filters, ev)) {
			console.log("[Subscription] event matches filters");
			this.#msgSender.sendEvent(this.#subId, ev);
		} else {
			console.log("[Subscription] event doesn't match filters");
		}
	}
}

class SubscriptionPool implements ISubscriptionPool {
	#subs = new Map<string, ISubscription>();

	static #subUniqId(peerId: string, subId: string): string {
		return `${peerId}/${subId}`;
	}

	register(sub: ISubscription): void {
		// if there is already a subscription with the same peer & subId, overwrite it with new one
		console.log(`[SubscriptionPool] register subscription (peer: ${sub.peerId}, subId: ${sub.subId})`);
		this.#subs.set(SubscriptionPool.#subUniqId(sub.peerId, sub.subId), sub);
	}
	unregister(peerId: string, subId: string): void {
		console.log(`[SubscriptionPool] unregister subscription (peer: ${peerId}, subId: ${subId})`);
		this.#subs.delete(SubscriptionPool.#subUniqId(peerId, subId));
	}

	broadcast(ev: NostrEvent): void {
		console.log(`[SubscriptionPool] broadcasting event to ${this.#subs.size} subscriptions...`);

		for (const sub of this.#subs.values()) {
			sub.broadcast(ev);
		}
	}
}

class EventIngestor implements IEventIngestor {
	#repo: IEventRepository;
	#subPool: ISubscriptionPool;

	constructor(repo: IEventRepository, subPool: ISubscriptionPool) {
		this.#repo = repo;
		this.#subPool = subPool;
	}

	ingest(ev: NostrEvent): EventIngestionOutcome {
		console.log(
			`[EventIngestor] ingesting event (id: ${ev.id}, author: ${ev.pubkey}, created_at: ${ev.created_at})...`,
		);

		const isEvValid = verifyEvent(ev);
		if (!isEvValid) {
			return { ok: false, msg: "error: invalid signature" };
		}
		const validationRes = validateEventSemantics(ev);
		if (!validationRes.ok) {
			switch (validationRes.err) {
				case "no-dtag-in-param-replaceable":
					return { ok: false, msg: "error: no d-tag in parametarized replaceable event" };
			}
		}

		// store events that are not ephemeral
		if (getEventHandling(ev) !== "ephemeral") {
			const insertionRes = this.#repo.insert(ev);
			if (!insertionRes.ok) {
				switch (insertionRes.err) {
					case "duplicated":
						return { ok: true, msg: "duplicate: already have this event" };
					case "deleted":
						return { ok: false, msg: "error: already deleted this event" };
				}
			}
		}

		this.#subPool.broadcast(ev);
		return { ok: true, msg: "" };
	}
}
