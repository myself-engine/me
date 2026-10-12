// "개발자 보기" switch: default off, stored per browser. When off the UI hides
// the trajectory timeline, raw diffs, worker harness/model/effort labels and the
// head chip's advanced options.
import { useCallback, useSyncExternalStore } from "react";

const KEY = "me.dev-view";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
};

export function useDevView(): [boolean, (v: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((v: boolean) => {
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {}
    for (const l of listeners) l();
  }, []);
  return [on, set];
}
