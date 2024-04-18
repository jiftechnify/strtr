export type Result<T, E> =
  | {
      ok: true;
      val: T;
    }
  | {
      ok: false;
      err: E;
    };

export const Result = {
  ok<T>(val: T): Result<T, never> {
    return { ok: true, val };
  },
  err<E>(err: E): Result<never, E> {
    return { ok: false, err };
  },
};
