import { useEffect, useRef, useState } from "react";

export function CopyButton({ value, label, copiedLabel, failedLabel }: { value: string; label: string; copiedLabel: string; failedLabel: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="copy-button" onClick={() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        setState("copied");
      } catch {
        setState("failed");
      }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 3_000);
    })();
  }}>{state === "copied" ? copiedLabel : state === "failed" ? failedLabel : label}</button>;
}
