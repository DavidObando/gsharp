# Agent instructions

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.
It gives the build, test, design, and PR requirements.
If the maintainer gives different instructions, obey the maintainer.

## Compiler requirements

Make compiler changes in G# on `main`.
Obey the N-1 rule in `CONTRIBUTING.md`.
Do not change the set of source files to make a build pass.
Do not change the SDK version to make a build pass.
Get maintainer approval before a workaround for a compiler defect.

If a compiler defect prevents a build, send the correction in a PR first.
That PR must build with the specified released compiler.
Use the new source only after a release with the correction becomes the specified compiler.

Keep emitted output the same between builds of the same input.
Do not use hash iteration order for numbers, names, or metadata order.
See [the bootstrap instructions](docs/self-host-bootstrap.md) for optional stage-2 certification.

Keep `PeBodyMutations.cs` in C#.
Do not rename `PackageContentHash.gsproj` or `TestSupervisorLogger.gsproj`.
The stage-2 controller uses these paths in `build/selfhost`.
Keep the Visual Studio extension in C#.
Keep its `#if NETFRAMEWORK` directives.

## PR review

Copilot examines each push automatically.
Do not start a Copilot review manually.
Do not use GitHub mention syntax for Copilot.
The GitHub mention starts an agent that can push changes.

After each push, do these steps:

1. Make sure that the new review uses the head commit.
2. Read all review threads and the summary sections named "Open" and "Previously missed".
3. Correct each finding that identifies an error.
4. Reply to each thread with the correction and commit ID.
5. If a finding is incorrect, give the reason in your reply.
6. Resolve each thread after the reply.

Before a merge, make sure that necessary checks pass.
Examine all pages of review threads for unresolved findings.
`mergeStateStatus: CLEAN` does not include unresolved threads.

If reviews find the same error again and again, correct the shared decision logic.
Do not add different corrections for each input shape.
Prevent a merge for incorrect output, unsound assertions, double evaluation, or unintended runtime behavior.
Record coverage gaps that produce explicit compile errors in the applicable issue.

Keep attribution and co-author lines out of commits and PR bodies.
Update PR bodies with this command:

```sh
gh api repos/DavidObando/gsharp/pulls/N -X PATCH -F body=@file
```

The command `gh pr edit --body-file` can fail without a useful error.

Add release notes in the "Unreleased" section of `website/docs/release-notes.md`.
After each rebase, read the complete file.
Keep all entries when you resolve conflicts.
Make an issue for a defect or architecture change that is not in the PR scope.
Add the issue link to the PR.

## CI failures

Before you run a job again, read the log for the failure:

```sh
gh api repos/DavidObando/gsharp/actions/jobs/<id>/logs
```

Show that the PR does not cause a failure before you run the job again.
For example, show the same failure on `main` or in a different PR.
The failure alone does not show that the PR caused the failure.
Get maintainer approval for a release if a scheduled workflow has a failure.

The `cs2gs-corpus` job runs translator tests.
The `cs2gs-apps-nightly` workflow translates external C# applications to G#.
It is not a PR or release requirement.
Its application versions are in `tools/cs2gs/external`.
Correct translator defects in cs2gs, not in the G# compiler's previous C# branch.

For an application failure, use `P0` only if the application previously passed on `main`.
The file `tools/cs2gs/apps-nightly-banked.json` records these applications.
If the application did not previously pass on `main`, use `P1`.
Keep priority labels accurate.

## Nullability

Before nullability changes, read [ADR-0186](docs/adr/0186-platform-types-for-oblivious-clr-interop.md) and [ADR-0193](docs/adr/0193-nullability-queries-are-type-level-and-funnelled.md).
Use these requirements:

- Keep `PlatformTypeSymbol` (`T!`) different from `NullableTypeSymbol` (`T?`).
- Use `--nullability=platform-types`, the default mode.
- Do not add support paths for the legacy `enabled` mode.
- Use `NullabilityImportRule` for decisions about imported nullability.
- Use `ClrNullability.Get*TypeSymbol` and receiver-aware `MemberLookup.GetClr*TypeSymbol` readers for signature positions.
- Do not use `TypeSymbol.FromClrType` or `MapOpenClrTypeToSymbolic` for these signature positions.
- Use the queries that the repository supplies.
- Do not add different calculations for the same nullability query.
- Read #4363 to find which query APIs have implementations.

For `[Nullable(2)]` on an open type-parameter position, the compiler gives reference-type arguments the type `T?`.
The compiler does not change value-type arguments.
The compiler does not change an unconstrained type parameter when that parameter is in scope.
Do not change these decisions without maintainer approval.

The expression `x!!` throws when `x` is null.
It is a runtime check, not an annotation.
Use `!!` only if null is an error that must stop execution.
If null is not an error, use a condition, `?.`, or a nullable signature.
Remove redundant assertions that cause GS0536.
The operator `?.` changes the result type and is not equivalent to an unconditional dereference.

## Issues

Give each open issue one priority label only:

| Label | Condition |
| --- | --- |
| `P0` | A check failure on `main`, a merge regression, a process crash, silent incorrect compilation in default mode, or a security defect. |
| `P1` | A defect with an example that reproduces the error. Examples include invalid IL, GS9998 on correct code, and translation that changes behavior without a diagnostic. |
| `P2` | A small defect, an appearance defect, a possible problem, work that the maintainer agrees not to do now, or architecture maintenance. |

Add the priority label when you make the issue.
Use the open cleanup issue for readability problems in translated source.

## Local work

Do not change work that you did not do.
If the same file also contains necessary corrections, remove experimental changes manually.
Do not replace the full file in that condition.
The Git stash is shared across worktrees.
Use a temporary commit.
If you use the stash, identify the entry by SHA.
Use that SHA to apply the entry.

On hosts with a shared RAM-backed `/tmp`, keep large work directories in `~/.cache/<tag>`.
Keep recovery information on disk, not in `/tmp`.
Remove temporary output after use.
After a crash or restart, examine `git status` in each worktree before you continue.

Stop processes by PID, not by a name or command pattern.
Start each long command one time.
Wait for the notification after the command stops.
Do not run status commands again and again.

## Multiple agents

Give each agent that makes commits a different worktree and branch.
Do not let these agents change the coordinator's working copy.
Keep coordination records on disk.

Give each agent the issue, applicable ADR decisions, completion requirements, and repository instructions.
Include the N-1 rule.
Keep the same agent for a PR through review revisions.
Send exact thread IDs, file locations, and applicable requirements with review findings.

The coordinator controls the merge.
Before a merge, make sure that CI results, review threads, and review coverage agree with the head commit.
