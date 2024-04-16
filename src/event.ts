/**
 * The data structure of Nostr event.
 */
export type NostrEvent = {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
	sig: string;
};

const regexp32BytesHexStr = /^[a-f0-9]{64}$/;
const regexp64BytesHexStr = /^[a-f0-9]{128}$/;

const is32BytesHexStr = (s: string): boolean => {
	return regexp32BytesHexStr.test(s);
};

const is64BytesHexStr = (s: string): boolean => {
	return regexp64BytesHexStr.test(s);
};

// schema validation for Nostr events
export const isNostrEvent = (rawEv: Record<string, unknown>): rawEv is NostrEvent => {
	// id: 32-bytes lowercase hex-encoded sha256
	if (!("id" in rawEv) || typeof rawEv["id"] !== "string" || !is32BytesHexStr(rawEv["id"])) {
		return false;
	}

	// pubkey: 32-bytes lowercase hex-encoded public key
	if (!("pubkey" in rawEv) || typeof rawEv["pubkey"] !== "string" || !is32BytesHexStr(rawEv["pubkey"])) {
		return false;
	}

	// created_at: unix timestamp in seconds
	if (!("created_at" in rawEv) || typeof rawEv["created_at"] !== "number") {
		return false;
	}

	// kind: integer
	if (!("kind" in rawEv) || typeof rawEv["kind"] !== "number") {
		return false;
	}

	// tags: array of arrays of non-null strings
	if (!("tags" in rawEv) || !Array.isArray(rawEv["tags"])) {
		return false;
	}
	if (rawEv["tags"].some((tag) => !Array.isArray(tag) || tag.some((e) => typeof e !== "string"))) {
		return false;
	}

	// content: string
	if (!("content" in rawEv) || typeof rawEv["content"] !== "string") {
		return false;
	}

	// sig: 64-bytes hex of the signature
	if (!("sig" in rawEv) || typeof rawEv["sig"] !== "string" || !is64BytesHexStr(rawEv["sig"])) {
		return false;
	}

	return true;
};

export const isEphemeralEvent = (ev: NostrEvent): boolean => 20000 <= ev.kind && ev.kind < 30000;
