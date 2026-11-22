/** Bubble classes for a guest's message. */
export function guestBubbleClassName(): string {
  return "bg-guest-surface";
}

/** The guest's name above their message, where "Sent by Fleet ADE" sits for server messages. */
export function GuestMessageName({ name }: { readonly name: string }) {
  return (
    <p className="me-1 text-2xs text-guest-foreground">
      {name}
      <span className="sr-only"> (guest)</span>
    </p>
  );
}
