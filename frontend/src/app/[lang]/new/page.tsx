import type { Metadata } from "next";
import { Header } from "@/ui/Header";
import { Wizard } from "./Wizard";

export const metadata: Metadata = { title: "Nuevo contrato / Novo contrato / New agreement" };

export default function NewAgreementPage() {
  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-20 pt-4 sm:px-8">
        <Wizard />
      </main>
    </div>
  );
}
