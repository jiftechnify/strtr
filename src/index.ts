import { type Filter, type Event as NostrEvent, matchFilters, verifyEvent } from "nostr-tools";
import { type WebSocket, WebSocketServer } from "ws";
import { type R2CMessageSender, createR2CMessageSender, parseC2RMessage } from "./message";

export const main = () => {
	const conns = new Set<Connection>();

	const repo = new EventRepositoryImpl();
	const subPool = new SubscriptionPoolImpl();
	const ingestor = new EventIngestorImpl(repo, subPool);
	const services: ServiceBundle = {
		repo,
		subPool,
		ingestor,
	};

	const wsServer = new WebSocketServer({ port: 8080 });
	wsServer.on("listening", () => {
		console.log("strtr listening on port 8080");
	});
	wsServer.on("connection", (ws, req) => {
		const peerId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
		console.log(`new connection from ${peerId}`);

		const conn = new ConnectionImpl(ws, peerId, services);
		conns.add(conn);

		ws.on("error", () => {
			console.error(`WebSocket error on ${peerId}`);
		});
		ws.on("close", (code) => {
			console.log(`WebSocket closed from client (code: ${code})`);
			conn.close("client");
			conns.delete(conn);
		});
	});

	// TODO: close all connections on receive signal
};

type ServiceBundle = {
	repo: EventRepository;
	subPool: SubscriptionPool;
	ingestor: EventIngestor;
};

type ConnectionCloser = "client" | "server";

interface Connection {
	close(closer: ConnectionCloser): void;
}

class ConnectionImpl implements Connection {
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

			if (parseResult.isOk) {
				const msg = parseResult.val;
				switch (msg[0]) {
					case "EVENT": {
						const ev = msg[1];

						this.#services.ingestor.ingest(ev, r2cMsgSender);
						break;
					}
					case "REQ": {
						const subId = msg[1];
						const filters = msg.slice(2) as Filter[];

						// TODO: skip querying if limit == 0
						// FIXME: how to handle events that are ingested by another clients while querying?
						this.#services.repo.query(subId, filters, r2cMsgSender);

						r2cMsgSender.sendEose(subId);

						const sub = new SubscriptionImpl(this.#peerId, subId, filters, r2cMsgSender);
						this.#services.subPool.register(sub);
						this.#activeSubs.add(subId);
						break;
					}
					case "CLOSE": {
						const subId = msg[1];

						if (this.#activeSubs.has(subId)) {
							this.#services.subPool.unregister(this.#peerId, subId);
							this.#activeSubs.delete(subId);
						}
						break;
					}
					default: {
						console.error(`Unknown message type: ${msg[0]}`);
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
			console.log("close connection from server");
			this.#ws.close();
		}
	}
}

interface EventRepository {
	insert(ev: NostrEvent): void;
	query(subId: string, filters: Filter[], msgSender: R2CMessageSender): void;
}

class EventRepositoryImpl implements EventRepository {
	insert(ev: NostrEvent): void {
		console.log(`[EventRepository] inserting event (id: ${ev.id}, author: ${ev.pubkey}, created_at: ${ev.created_at})`);
	}

	query(subId: string, filters: Filter[], msgSender: R2CMessageSender): void {
		console.log(`[EventRepository] querying event (subId: ${subId}, filters: ${filters})`);
		// TODO: send matched events
	}
}

interface Subscription {
	readonly peerId: string;
	readonly subId: string;

	broadcast(ev: NostrEvent): void;
}

class SubscriptionImpl implements Subscription {
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

interface SubscriptionPool {
	register(sub: Subscription): void;
	unregister(peerId: string, subId: string): void;

	broadcast(ev: NostrEvent): void;
}

class SubscriptionPoolImpl implements SubscriptionPool {
	#subs = new Map<string, Subscription>();

	static #subUniqId(peerId: string, subId: string): string {
		return `${peerId}/${subId}`;
	}

	register(sub: Subscription): void {
		// if there is already a subscription with the same peer & subId, overwrite it with new one
		this.#subs.set(SubscriptionPoolImpl.#subUniqId(sub.peerId, sub.subId), sub);
	}
	unregister(peerId: string, subId: string): void {
		this.#subs.delete(SubscriptionPoolImpl.#subUniqId(peerId, subId));
	}

	broadcast(ev: NostrEvent): void {
		console.log(`[SubscriptionPool] broadcasting event to ${this.#subs.size} subscriptions...`);

		for (const sub of this.#subs.values()) {
			sub.broadcast(ev);
		}
	}
}

interface EventIngestor {
	ingest(ev: NostrEvent, msgSender: R2CMessageSender): void;
}

class EventIngestorImpl implements EventIngestor {
	#repo: EventRepository;
	#subPool: SubscriptionPool;

	constructor(repo: EventRepository, subPool: SubscriptionPool) {
		this.#repo = repo;
		this.#subPool = subPool;
	}

	ingest(ev: NostrEvent, msgSender: R2CMessageSender): void {
		console.log(
			`[EventIngestor] ingesting event (id: ${ev.id}, author: ${ev.pubkey}, created_at: ${ev.created_at})...`,
		);

		const isEvValid = verifyEvent(ev);
		if (!isEvValid) {
			msgSender.sendOk(ev.id, false, "error: invalid signature");
			return;
		}

		this.#subPool.broadcast(ev);
		this.#repo.insert(ev);
		// TODO: handle errors
		msgSender.sendOk(ev.id, true);
	}
}