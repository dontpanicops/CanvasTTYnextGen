import { useCallback, useEffect, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

// What the clipboard answered: "copied" only when the main process read the text back.
export async function copyText(text: string): Promise<Exclude<CopyState, "idle">> {
  try {
    return (await window.canvasTTY.clipboard.writeText(text)) ? "copied" : "failed";
  } catch {
    return "failed";
  }
}

// The words of a «Copy» control: its own for idle and copied, one for every failed copy.
export function copyKey<K extends string>(state: CopyState, idle: K, copied: K): K | "copyFailed" {
  return state === "copied" ? copied : state === "failed" ? "copyFailed" : idle;
}

// The state of a «Copy» control: what the last copy answered, back to idle after `resetMs`.
export function useCopy(resetMs = 2000): [CopyState, (text: string) => Promise<void>] {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), resetMs);
    return () => window.clearTimeout(timer);
  }, [state, resetMs]);
  const copy = useCallback(async (text: string) => setState(await copyText(text)), []);
  return [state, copy];
}
