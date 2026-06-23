"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function AdminAutoRefresh({ intervalSeconds = 30 }: { intervalSeconds?: number }) {
  const router = useRouter();
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(intervalSeconds);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setSecondsUntilRefresh((current) => {
        if (current <= 1) {
          router.refresh();
          return intervalSeconds;
        }
        return current - 1;
      });
    }, 1_000);

    return () => window.clearInterval(tick);
  }, [intervalSeconds, router]);

  return (
    <button
      className="button-secondary inline-flex items-center gap-2"
      onClick={() => {
        setSecondsUntilRefresh(intervalSeconds);
        router.refresh();
      }}
      type="button"
    >
      <RefreshCw size={16} aria-hidden="true" />
      Refreshes in {secondsUntilRefresh}s
    </button>
  );
}
