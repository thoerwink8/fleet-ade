import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry([
  GitHub.definition,
]);
