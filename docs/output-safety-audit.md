# Output Safety Audit

This audit covers graph-provided text and operator-provided paths that flow into generated HTML, SVG, browser-rendered visualizer HTML, worker logs, reports, prompt templates, and Slack notifications.

| Sink | Source | Sanitizer or trust assumption |
| --- | --- | --- |
| Static renderer HTML text | `document` fields, graph title, table cells, callouts | `escapeHtml` escapes text before insertion. `renderRichText` intentionally allows only literal `<code>` and `</code>` tags after escaping all other HTML. |
| Static renderer links | `document.nav[].href` | `safeHref` permits empty, relative, `http`, `https`, and `mailto` URLs; control/whitespace-obfuscated schemes such as `jav\tascript:` and other schemes become `#`. Attribute text is still HTML-escaped. |
| Static renderer callout class | `document.callouts[].type` | `classToken` reduces the value to a CSS-safe token before HTML escaping the attribute. |
| Planar SVG | graph title, node ids, node titles, node kind/status | SVG text and attributes use `escapeHtml`; status-derived classes use `classToken`; coordinates come from numeric layout code. |
| Visualizer `graphSvg` insertion | server-generated planar SVG | The browser inserts `payload.graphSvg` as HTML. The server generates this SVG through `renderPlanarSvg`, so graph text is already escaped before it reaches `innerHTML`. |
| Visualizer node lists and summaries | graph node fields, questions, answers, report paths, counts | Client renderers call `escapeHtml`; dynamic class tokens use `statusToken`; form data attributes are HTML-escaped. |
| Visualizer worker log tail | child process stdout/stderr chunks | The Worker Manager redacts common token, webhook, bearer, and credential-bearing URL forms before retaining log text. Client renderers still call `escapeHtml` before inserting log text into `.log-tail`. Logs remain sensitive data and are exposed to anyone who can access the visualizer. |
| Slack notification text | node id/title, question, answer, reason, report path, graph counts | `slackText` escapes Slack link/mention delimiters, common mrkdwn markers in graph-provided fields, and flattens line breaks. The scheduler-owned event label is intentionally rendered with `*EVENT*` mrkdwn. |
| Report file path | CLI `--report` or worker default report path | `resolveGraphRelativePath` confines the path to the graph directory; `writeReportFile` rejects symlink parents and existing symlink targets so report writes cannot follow `reports -> outside` or `reports/file.md -> outside`. |
| Report Markdown body | worker stdout/stderr/error and manual `--report-body` | Reports are Markdown files for trusted operators, not browser-rendered by the scheduler. Worker reports redact common token/webhook/password forms and credential-bearing URL userinfo before writing. Rich Markdown is intentionally allowed in report bodies. |
| Prompt template path | CLI/visualizer `--template` | Template paths are operator-controlled. Relative paths resolve from the graph directory; absolute paths are allowed for explicit operator templates. Missing template variables remain visible as `{{name}}`. |
| Prompt template output | graph fields and JSON snapshots | Prompt output is plain text passed to the configured worker command. The scheduler does not execute template contents as code. Custom templates and worker commands are trusted-operator surfaces. |
| Renderer output path | CLI `--output`/`--out`, positional output, `scheduler.htmlView` | Renderer output is an operator or graph metadata location resolved from the graph directory. Treat graph files as trusted before rendering because this path controls where generated HTML is written. |

The intentionally allowed rich-text surfaces are renderer `<code>` tags in document table/callout text, the scheduler-owned Slack `*EVENT*` label, Markdown inside report bodies, and raw prompt template text. Tests cover those assumptions.

Red-team coverage added for hostile graph titles, node ids, report paths, document content, worker log text, and Slack fields:

- HTML/SVG sinks: static renderer document fields, links, rich text, callout classes, planar SVG labels, graph title `aria-label`, and node id `data-id` attributes are covered by escaping tests.
- Browser visualizer sinks: ready/working node lists, answer fields, reports, isolation refs, worker metadata, and worker log tails are covered by client-renderer escaping tests.
- Slack sinks: event labels, node ids, node titles, graph counts, and report details are covered by mrkdwn/link/mention escaping tests; non-chat details such as question, answer, reason, and report body remain intentionally omitted.
- Report write sinks: explicit report paths, hostile worker-generated default report names, parent-directory traversal, file-as-parent failures, and symlink escapes are covered by containment tests.
