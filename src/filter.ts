import type { Filter } from "nostr-tools/filter";

type TagQueryKey = `#${string}`;

// checks if `s` has the pattern of tag query key (e.g. "#" + single letter)
export const isTagQueryKey = (s: string): s is TagQueryKey => {
  return s.startsWith("#") && s.length === 2;
};

export const isReqFilter = (raw: Record<string, unknown>): raw is Filter => {
  if ("ids" in raw && !Array.isArray(raw["ids"])) {
    return false;
  }
  if ("kinds" in raw && !Array.isArray(raw["kinds"])) {
    return false;
  }
  if ("authors" in raw && !Array.isArray(raw["authors"])) {
    return false;
  }
  if ("since" in raw && typeof raw["since"] !== "number") {
    return false;
  }
  if ("until" in raw && typeof raw["until"] !== "number") {
    return false;
  }
  if ("limit" in raw && typeof raw["limit"] !== "number") {
    return false;
  }
  if ("search" in raw && typeof raw["search"] !== "string") {
    return false;
  }
  for (const tqk of Object.keys(raw).filter((k) => isTagQueryKey(k))) {
    if (!Array.isArray(raw[tqk])) {
      return false;
    }
  }

  return true;
};

export const isNeverMatchingFilter = (f: Filter): boolean => {
  if (f.since !== undefined && f.until !== undefined && f.since > f.until) {
    return true;
  }
  if (f.ids !== undefined && f.ids.length === 0) {
    return true;
  }
  if (f.authors !== undefined && f.authors.length === 0) {
    return true;
  }
  if (f.kinds !== undefined && f.kinds.length === 0) {
    return true;
  }
  for (const tqk of Object.keys(f).filter(isTagQueryKey)) {
    const tq = f[tqk];
    if (tq !== undefined && tq.length === 0) {
      return true;
    }
  }
  return false;
};
