import { makeSecretProviderDefinitionRegistry } from "@t3tools/secret-provider-core/shared/definition";

/** No kind ships today, so a provider saved by an older build is listed as unsupported. */
export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([]);
