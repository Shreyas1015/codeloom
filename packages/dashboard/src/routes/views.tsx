import { useParams } from "@tanstack/react-router";
import { HomeRoute } from "@/routes/index";
import { ViewScreen } from "@/screens/views/ViewScreen";

/** One saved view (`/views/$id`). `home` is Home itself, so `/views/home` shows what `/` shows. */
export function ViewRoute() {
  const { id } = useParams({ from: "/views/$id" });
  if (id === "home") return <HomeRoute />;
  return <ViewScreen key={id} id={id} />;
}
