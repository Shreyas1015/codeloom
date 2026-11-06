import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useOverview } from "@/api/queries";
import { PHASE_IDS } from "./model";
import { readTourPlace } from "./position";

/** The Journey screen's way into Tour mode: "Resume tour" at the place this browser remembers while some
 * phase is still unviewed, else "Start tour" (Tour mode itself says when there is no tour yet). */
export function TourButton({ journeyId }: { journeyId: string }) {
  const workspace = useOverview().data?.name;
  const stored = workspace ? readTourPlace(workspace, journeyId) : undefined;
  const resume = stored && !PHASE_IDS.every((p) => stored.viewed.includes(p)) ? stored : undefined;
  return (
    <Link
      to="/journeys/$id/tour"
      params={{ id: journeyId }}
      search={resume ? { phase: resume.phase, stop: resume.stop } : {}}
      className="inline-flex h-9 flex-none items-center gap-2 rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-colors outline-offset-2 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
    >
      <Play aria-hidden className="size-4" />
      {resume ? "Resume tour" : "Start tour"}
    </Link>
  );
}
