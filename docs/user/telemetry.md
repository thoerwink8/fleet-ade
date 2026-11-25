# Telemetry

Fleet ADE does not send product usage. Token counts stay on your computer. Model names, project and
thread titles, activity status, and computer and thread identifiers are sent only when
**Publish agent activity** is on. That switch is off until you turn it on.

What can leave the computer:

- Agent activity, when **Publish agent activity** is on. To turn it off, open
  **Settings > Connections** on the computer and turn off **Publish agent activity**.
- Traces, metrics, or logs you send to an OpenTelemetry receiver of your own.

Prompts, responses, and file contents are not included.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select a computer, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that computer's background service. The receiver must be reachable from the service's computer.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
