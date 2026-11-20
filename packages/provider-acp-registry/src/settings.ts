import { TrimmedString, makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const AcpRegistryDistributionPreference = Schema.Literals(["auto", "binary", "npx", "uvx"]);
export type AcpRegistryDistributionPreference = typeof AcpRegistryDistributionPreference.Type;

export const AcpRegistrySettings = makeProviderSettingsSchema(
  {
    source: Schema.Literals(["registry", "local"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("registry")),
      Schema.annotateKey({
        title: "ACP 来源",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "registry", label: "ACP Registry" },
            { value: "local", label: "本地命令" },
          ],
        },
      }),
    ),
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    agentId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Registry 智能体 ID",
        description: "官方 ACP Registry 里的智能体标识，例如 'devin'。",
        providerSettingsForm: { placeholder: "devin", clearWhenEmpty: "persist" },
      }),
    ),
    commandPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Executable override",
        description:
          "Executable on this environment. For registry agents, this overrides the distribution executable while keeping its arguments and environment.",
        providerSettingsForm: { placeholder: "Registry default", clearWhenEmpty: "omit" },
      }),
    ),
    commandArgs: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    authMethodId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Authentication method",
        description:
          "Optional ACP authentication method ID. By default, the first agent-managed method is selected.",
        providerSettingsForm: { placeholder: "auto", clearWhenEmpty: "omit" },
      }),
    ),
    distribution: AcpRegistryDistributionPreference.pipe(
      Schema.withDecodingDefault(Effect.succeed("auto")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    stdioMcpServers: Schema.Array(
      Schema.Struct({
        name: TrimmedString,
        command: TrimmedString,
        args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
        env: Schema.Array(
          Schema.Struct({
            name: TrimmedString,
            value: Schema.String,
          }),
        ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
      }),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({
        title: "Stdio MCP servers",
        description:
          "Extra stdio MCP servers appended for a local omp instance. Other ACP agents ignore this.",
        providerSettingsForm: { hidden: true },
      }),
    ),
  },
  {
    order: ["source", "agentId", "commandPath", "authMethodId"],
  },
);
export type AcpRegistrySettings = typeof AcpRegistrySettings.Type;
