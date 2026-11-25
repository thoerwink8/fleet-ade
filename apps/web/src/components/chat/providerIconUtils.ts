import { formatModelDisplayName } from "@t3tools/client-runtime/model-display";

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export function getDisplayModelName(model: Pick<ModelEsque, "slug" | "name">): string {
  return formatModelDisplayName(model);
}
