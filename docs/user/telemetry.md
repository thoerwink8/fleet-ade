# Telemetry

T3 Code does not send product usage. Token counts stay on your machine. Model names, project and
thread titles, activity status, and environment and thread identifiers are sent only when
**Publish agent activity** is on. That switch is off until you turn it on.

What can leave the machine:

- Relay connection traces, sent to Axiom to diagnose T3 Connect. To turn them off, set
  `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before you start it. They also stop
  when `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` turns OpenTelemetry export off. The
  browser app has no switch for its own traces.
- Agent activity, when **Publish agent activity** is on. To turn it off, open
  **Settings > Connections** on the host and turn off **Publish agent activity**.
- Traces, metrics, or logs you send to an OpenTelemetry receiver of your own.

Prompts, responses, and file contents are not included.

## Relay connection diagnostics

T3 Code sends relay connection traces to Axiom to diagnose T3 Connect connectivity.

Traces record how long a connection step took. A failed trace can include the error message and
stack trace. Error text can quote a value the app was handling.

To turn relay tracing off, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
you start it. Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` turns
OpenTelemetry export off. `T3CODE_TELEMETRY_ENABLED=false` stops relay tracing only. An endpoint you
set yourself keeps exporting until one of those OpenTelemetry switches turns export off.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on
macOS and Linux, so export it there and restart the app. On Windows, set it as a user environment
variable.

The web app in a browser, including one the `t3` CLI opens, does not read these environment
variables. It can send its own connection traces even if the server has opted out. The browser app has
no relay tracing toggle.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
mobile notifications and live activities. The switch is off until you turn it on. Turning off
relay tracing does not stop this.

To stop publishing, turn off **Publish agent activity** under **Settings > Connections** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
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
