import { ZapIcon } from "lucide-react";

/** One bolt for Fast. Ultrafast adds an outlined echo behind it, cut away by the surface color. */
export function FastBolt(props: { ultra: boolean }) {
  if (!props.ultra) {
    return (
      <ZapIcon aria-hidden="true" data-composer-control-icon className="size-3 fill-current" />
    );
  }
  return (
    <span aria-hidden="true" className="relative h-3 w-3.75 shrink-0">
      <ZapIcon className="absolute top-0 left-0.75 size-3" />
      <ZapIcon
        strokeWidth={4}
        className="absolute top-0 left-0 size-3 fill-current stroke-(--chat-composer-glass-surface) [paint-order:stroke]"
      />
    </span>
  );
}
