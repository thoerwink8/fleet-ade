import * as Schema from "effect/Schema";

export const ExternalQuotaWindow = Schema.Struct({
  label: Schema.String,
  remainingPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
});
export type ExternalQuotaWindow = typeof ExternalQuotaWindow.Type;

export const ExternalQuotaGroup = Schema.Struct({
  name: Schema.String,
  windows: Schema.Array(ExternalQuotaWindow),
});
export type ExternalQuotaGroup = typeof ExternalQuotaGroup.Type;

const ExternalQuotaFailure = Schema.Struct({
  ok: Schema.Literal(false),
  message: Schema.String,
});

export const ExternalQuotaGroups = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    groups: Schema.Array(ExternalQuotaGroup),
  }),
  ExternalQuotaFailure,
]);
export type ExternalQuotaGroups = typeof ExternalQuotaGroups.Type;

export const ExternalUsageRow = Schema.Struct({
  name: Schema.String,
  calls: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.Number,
});
export type ExternalUsageRow = typeof ExternalUsageRow.Type;

export const ExternalUsageReport = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    agents: Schema.Array(ExternalUsageRow),
    models: Schema.Array(ExternalUsageRow),
  }),
  ExternalQuotaFailure,
]);
export type ExternalUsageReport = typeof ExternalUsageReport.Type;

export const ExternalQuotas = Schema.Struct({
  agy: ExternalQuotaGroups,
  magpieQuotas: ExternalQuotaGroups,
  magpieUsage: ExternalUsageReport,
});
export type ExternalQuotas = typeof ExternalQuotas.Type;
