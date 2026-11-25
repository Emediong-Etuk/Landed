"use client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TourProvider } from "./Tour";
import { ErrorBanner } from "./ErrorBanner";

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={qc}>
      <TourProvider>
        {children}
        <ErrorBanner />
      </TourProvider>
    </QueryClientProvider>
  );
}
