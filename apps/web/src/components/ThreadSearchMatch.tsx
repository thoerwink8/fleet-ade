import {
  findSearchTokenRanges,
  splitSearchText,
  type SearchMatchHint,
  type SearchRange,
} from "@t3tools/shared/paletteSearch";

/** `text` with each range marked. Palette rows use the library wash; other rows keep emphasis. */
function HighlightedSearchText(props: {
  text: string;
  ranges: ReadonlyArray<SearchRange>;
  tone?: "status" | "neutral";
}) {
  if (props.ranges.length === 0) return props.text;
  const neutral = props.tone === "neutral";
  return splitSearchText(props.text, props.ranges).map((part) =>
    part.highlighted ? (
      <mark
        className={neutral ? "fa-mark" : "bg-transparent font-semibold text-foreground"}
        key={part.start}
      >
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

/** Why a row matched when its title does not show it: the field and its match. */
export function SearchMatchHintLine(props: { hint: SearchMatchHint }) {
  return (
    <span>
      <span>{props.hint.label}:</span>{" "}
      <HighlightedSearchText tone="neutral" text={props.hint.text} ranges={props.hint.ranges} />
    </span>
  );
}

export function ThreadSearchMatchExcerpt(props: {
  match: {
    readonly source: "user" | "assistant";
    readonly snippet: string;
    readonly query: string;
  };
  size?: "xs" | "row";
  tone?: "status" | "neutral";
}) {
  const isUser = props.match.source === "user";
  const neutral = props.tone === "neutral";
  return (
    <span
      className={
        neutral
          ? undefined
          : props.size === "row"
            ? "truncate text-row text-muted-foreground/85"
            : "truncate text-xs text-muted-foreground/85"
      }
    >
      <span
        className={
          neutral ? undefined : isUser ? "text-info-foreground" : "text-success-foreground"
        }
      >
        {isUser ? "你：" : "智能体："}
      </span>{" "}
      <HighlightedSearchText
        tone={neutral ? "neutral" : "status"}
        text={props.match.snippet}
        ranges={findSearchTokenRanges(props.match.snippet, props.match.query)}
      />
    </span>
  );
}
