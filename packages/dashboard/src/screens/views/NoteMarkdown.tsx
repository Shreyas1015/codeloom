import { Markdown } from "@/screens/tour/markdown";

/** A view note: the shared safe Markdown subset (never raw HTML) with headings and in-app / http(s) links.
 * A note's `#` sits under the view title (h1) and the widget, so it renders as h3. */
export function NoteMarkdown({ text, className }: { text: string; className?: string }) {
  return <Markdown text={text} headings={3} links className={className} />;
}
