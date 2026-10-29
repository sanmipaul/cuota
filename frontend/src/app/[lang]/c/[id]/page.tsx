import { Suspense } from "react";
import { Header } from "@/ui/Header";
import { Skeleton } from "@/ui/kit";
import { Agreement } from "./Agreement";

export default function AgreementPage() {
  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 pb-20 pt-4 sm:px-8">
        <Suspense fallback={<Skeleton className="h-[560px]" />}>
          <Agreement />
        </Suspense>
      </main>
    </div>
  );
}
