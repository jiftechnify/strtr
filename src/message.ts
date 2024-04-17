import type { Event as NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { WebSocket } from "ws";

import { isNostrEvent } from "./event";
import { isReqFilter } from "./filter";
import { Result } from "./types";

/* client to relay (C2R) message parsing */
const c2rMsgNames = ["EVENT", "REQ", "CLOSE", "AUTH", "COUNT"] as const;
type C2RMsgName = (typeof c2rMsgNames)[number];

const isC2RMsgName = (s: string): s is C2RMsgName => (c2rMsgNames as readonly string[]).includes(s);

const supportedC2RMsgNames = ["EVENT", "REQ", "CLOSE"] as const;
const isSupportedC2RMsgName = (s: C2RMsgName): s is "EVENT" | "REQ" | "CLOSE" =>
	(supportedC2RMsgNames as readonly string[]).includes(s);

export type C2RMessage =
	| [type: "EVENT", ev: NostrEvent]
	| [type: "REQ", subId: string, ...filters: Filter[]]
	| [type: "CLOSE", subId: string];

type ParseC2RMessageError = { errType: "malformed" } | { errType: "unsupported"; msgType: string };

export const parseC2RMessage = (s: string): Result<C2RMessage, ParseC2RMessageError> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(s) as unknown;
	} catch (err) {
		console.error(err);
		return Result.err({ errType: "malformed" });
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "string") {
		return Result.err({ errType: "malformed" });
	}

	if (!isC2RMsgName(parsed[0])) {
		return Result.err({ errType: "malformed" });
	}
	if (!isSupportedC2RMsgName(parsed[0])) {
		return Result.err({ errType: "unsupported", msgType: parsed[0] });
	}

	switch (parsed[0]) {
		case "EVENT": {
			if (parsed.length !== 2) {
				return Result.err({ errType: "malformed" });
			}
			if (!isNostrEvent(parsed[1])) {
				return Result.err({ errType: "malformed" });
			}
			return Result.ok(parsed as C2RMessage);
		}
		case "REQ": {
			if (parsed.length < 3) {
				return Result.err({ errType: "malformed" });
			}
			if (typeof parsed[1] !== "string") {
				return Result.err({ errType: "malformed" });
			}
			if (parsed.slice(2).some((f) => !isReqFilter(f))) {
				return Result.err({ errType: "malformed" });
			}
			return Result.ok(parsed as C2RMessage);
		}
		case "CLOSE": {
			if (parsed.length !== 2) {
				return Result.err({ errType: "malformed" });
			}
			if (typeof parsed[1] !== "string") {
				return Result.err({ errType: "malformed" });
			}
			return Result.ok(parsed as C2RMessage);
		}
	}
};

export type R2CMessageSender = {
	sendEvent: (subId: string, ev: NostrEvent) => void;
	sendOk: (eventId: string, ok: boolean, message?: string) => void;
	sendEose: (subId: string) => void;
	sendClosed: (subId: string, message: string) => void;
	sendNotice: (message: string) => void;
};

export const createR2CMessageSender = (ws: WebSocket): R2CMessageSender => {
	return {
		sendEvent: (subId: string, ev: NostrEvent) => {
			ws.send(JSON.stringify(["EVENT", subId, ev]));
		},
		sendOk: (eventId: string, ok: boolean, message = "") => {
			ws.send(JSON.stringify(["OK", eventId, ok, message]));
		},
		sendEose: (subId: string) => {
			ws.send(JSON.stringify(["EOSE", subId]));
		},
		sendClosed: (subId: string, message: string) => {
			ws.send(JSON.stringify(["CLOSED", subId, message]));
		},
		sendNotice: (message: string) => {
			ws.send(JSON.stringify(["NOTICE", message]));
		},
	};
};
