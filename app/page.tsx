import { LoopHouse } from "@/components/LoopHouse";

export const dynamic = "force-dynamic";

export default function Page() {
  return <LoopHouse configured={Boolean(process.env.REACTOR_API_KEY)} />;
}
