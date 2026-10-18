# Security

The default stack is a localhost-only synthetic evaluation lab. Do not expose its default keys or database credentials to a network. Agent tokens are per-run opaque credentials; reviewer and internal service keys are separate. Scenario notes and tool responses are untrusted inputs.

Please report security issues privately to the repository maintainer through the hosting platform's private security advisory feature when available. Do not include live credentials or real personnel information in an issue. Describe the affected boundary, minimal reproduction, expected denial and observed trace/database result.

See [the threat model](docs/threat-model.md) for implemented defenses, tested cases and deployment limits. In particular, application queries enforce scope; the demonstration does not claim PostgreSQL row-level security or production identity integration. Sensitive-field filtering is defense in depth and cannot guarantee detection of arbitrary personal data in free text.
