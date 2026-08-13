# Security policy

## Supported versions

G# is pre-1.0. Security fixes target the latest tagged release and `main`.
Older release lines are not serviced; upgrade to the newest release before
reporting or applying a fix.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** form:

<https://github.com/DavidObando/gsharp/security/advisories/new>

Do not open a public issue. Include affected version or commit, platform,
reproduction, impact, and any known workaround. Maintainers will coordinate
validation, remediation, release, and disclosure through the private advisory.

## Trust boundary

The compiler is not a sandbox. `gsi` executes submitted code, and building a
project can execute MSBuild tasks and source generators. `cs2gs` migration can
restore, build, and run projects to compare behavior. Do not use these tools on
untrusted projects outside an appropriately isolated environment.

Report vulnerabilities where attacker-controlled source, project metadata,
packages, or protocol input can cross the documented boundary—for example,
arbitrary execution before the user requested a build/run, path traversal,
unsafe command construction, credential disclosure, or a practical
denial-of-service. Ordinary behavior of code explicitly compiled or executed
by the user is not a sandbox escape.

For dependency vulnerabilities, identify the package and advisory when
possible. Checked-in lock files define the dependency graph used by CI and
releases.
