import { ReviewScreen } from "@/screens/review/ReviewScreen";

/** Review (`/review`): the start page in a hosted PR snapshot — the impact of this PR (counts, affected
 * journeys, changed files, and each changed stop's code). Reached only once `isSnapshot()` is true
 * (router.tsx redirects "/review" to "/" outside a snapshot, the same pairing as "/" and "/progress"
 * redirecting here once a snapshot is detected). */
export function ReviewRoute() {
  return <ReviewScreen />;
}
