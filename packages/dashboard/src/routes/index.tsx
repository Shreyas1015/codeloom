import { FileWarning } from "lucide-react";
import { useView } from "@/api/queries";
import { Command } from "@/components/gallery/CopyCommand";
import { HomeScreen } from "@/screens/home/HomeScreen";
import { ViewBody } from "@/screens/views/ViewScreen";

/** Home (`/`): the `home` view when `.codeloom/views/home.json` exists and is valid; otherwise the built-in
 * Home, with a quiet notice when home.json is there but broken. Any failure to read the view (an older
 * server, a network error) falls back to the built-in Home too: a bad view never costs you Home.
 * While the view is still loading the built-in Home starts loading as well (most workspaces have no home
 * view), so Home is never held back by it; a local file answers before the journeys do. */
export function HomeRoute() {
  const { data } = useView("home");
  if (data?.view) return <ViewBody view={data.view} home />;
  return (
    <>
      {data?.error && <HomeViewNotice error={data.error} />}
      <HomeScreen />
    </>
  );
}

function HomeViewNotice({ error }: { error: string }) {
  return (
    <div role="status" aria-label="Home view" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-[13px]">
      <FileWarning aria-hidden className="size-4 shrink-0 text-destructive" />
      <span title={error}>
        Your home view can't be read, so this is the built-in Home. <span className="text-muted-foreground">Check</span>{" "}
        <code className="font-mono text-[12px]">.codeloom/views/home.json</code> <span className="text-muted-foreground">with</span>
      </span>
      <Command text="codeloom doctor" />
    </div>
  );
}
