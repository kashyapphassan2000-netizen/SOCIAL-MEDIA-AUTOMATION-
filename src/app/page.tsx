import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth";
import { Dashboard } from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const s = await readSession();
  if (!s) redirect("/login");
  return <Dashboard user={s} />;
}
