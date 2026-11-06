import { useRouter } from "@tanstack/react-router";
import type { ComponentProps, MouseEvent } from "react";

/** A link to a Tour mode URL (`tourHref`), navigated in the app. It takes a built href rather than a typed
 * route, so the screens that send viewers into a tour (Home, Progress) need not know Tour mode's route. */
export function TourLink({ href, onClick, ...rest }: ComponentProps<"a"> & { href: string }) {
  const router = useRouter();
  function go(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.history.push(href);
  }
  return <a href={href} onClick={go} {...rest} />;
}
