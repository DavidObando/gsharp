# Phase 4 issue-triage and repository-settings checklist

For the owner (or an agent the owner directs). Nothing here has been run.
Plan: #3501, comment of 2026-10-01, Phase 4 items 4 and 6. Each close below has
a verification step that must pass first; each verification is read-only.

State as read on 2026-10-09: #4302 is already CLOSED; #4304, #4569 and #4355 are
OPEN.

## 1. Verify, then close

### #4302 (`__local_` tracker): already closed

Nothing to do. If it was closed by PR #4582, confirm the `__local_` ceiling in
`tools/cs2gs/selfmig-baseline.json` is 0 (the file is retired at the cut-over;
check the last C# nightly's report instead).

### #4304 (`__q{N}` transparent-identifier carrier): obsolete

Obsolete when cs2gs no longer emits `__q{N}`. Evidence on `main` today: the code
comment at `tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Types.cs:3555`
says ADR-0185 retired the scheme; the retiring PRs are #4317 and #4318.

```sh
# 1. No synthesized __q name is produced (expect: only comments / the retired-name guard).
grep -rn '__q' tools/cs2gs/Cs2Gs.Translator/ | grep -v '^\S*:\s*[0-9]*:\s*//'
# 2. The last nightly translation of the corpus contains none (download the
#    run's migrated tree artifact first, then:)
grep -rl '__q[0-9]' <migrated-tree> --include=*.gs | wc -l   # expect 0
# 3. The merging PRs
gh pr view 4318 --json state,mergedAt --jq '.state,.mergedAt'
gh pr view 4317 --json state,mergedAt --jq '.state,.mergedAt'
```

Close (when 1-3 pass):

```sh
gh issue close 4304 --repo DavidObando/gsharp --reason completed \
  --comment "Fixed by #4317 and #4318 (ADR-0185 retired the __q{N} carrier). Verified: no __q name is synthesized and the last corpus translation contains none."
```

### #4569 (spread elements ignored by managed-reference projection inference): obsolete

Obsolete when `GetManagedReferenceArrayProjectedCollectionType` handles
`SpreadElementSyntax`. Evidence: `CSharpToGSharpTranslator.Patterns.cs` around
line 4551 has a `SpreadElementSyntax spread =>` arm in that function. Confirm a
test pins it.

```sh
grep -n 'SpreadElementSyntax' tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Patterns.cs
grep -rlnE 'GetManagedReferenceArrayProjectedCollectionType\|\[\.\.widened\]' tools/cs2gs/Cs2Gs.Tests | head
```

If there is no test with a spread element (`[..widened]` style), add one before
closing (ADR-0154 witness: red on the pre-fix commit). Then:

```sh
gh issue close 4569 --repo DavidObando/gsharp --reason completed \
  --comment "Fixed by #4545 (spread elements now contribute to the projected element type; pinned by <test name>)."
```

Check the PR number in the comment against `git log -S'SpreadElementSyntax spread =>' -- tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Patterns.cs`.

### #4355 (constructor-call receiver drops nullable type argument): likely obsolete, needs a pinning test

The plan says "not reproducible; likely fixed by #4357; add pinning test, close".
It is a gsc binder defect, so it is verified with a G# repro, not by reading cs2gs.

```sh
mkdir -p ~/.cache/triage-4355 && cd ~/.cache/triage-4355
# Repro from the issue body: Box[List[int32]?]().Value must type as List[int32]?
#   let probe = Box[List[int32]?]().Value
#   let b = Box[List[int32]?]()
#   let probe2 = b.Value
# Compile it with the current pinned SDK and read the inferred types, e.g. via
# `gsc` hover/semantic-model or a binder test. Both must be NullableTypeSymbol.
```

Close only after a test that asserts both `probe` and `probe2` are `List[int32]?`
is on `main` (witness: it fails on the commit before #4357). Then:

```sh
gh issue close 4355 --repo DavidObando/gsharp --reason completed \
  --comment "Fixed by #4357 (ADR-0186 step 5). Pinned by <test name> in <PR>."
```

If the repro still types `probe` as non-null, do NOT close: keep it P1.

## 2. Relabel and sweep

Relabel per section 2.5 of the plan. #4421, #4448 and #4523 were already moved
to P1 on 2026-10-01. Re-check that every open issue still carries exactly one of
P0/P1/P2:

```sh
gh issue list --repo DavidObando/gsharp --state open --limit 300 --json number,labels \
  --jq '.[] | select([.labels[].name | select(. == "P0" or . == "P1" or . == "P2")] | length != 1) | .number'
```

Expect no output. Label each number printed.

### Sweep `gap:readability` into one post-cut-over cleanup issue

```sh
gh issue list --repo DavidObando/gsharp --state open --label gap:readability --limit 100 \
  --json number,title --jq '.[] | "#\(.number) \(.title)"'
```

As read on 2026-10-09 this includes #4303, #4305, #4306, #4307 and #4566 (the first page of the list; re-run the command for the full set) (`__pattern`,
`__scrutinee`, `__spill`, `__underscore` names; #4304 closes in section 1;
#4566 is a wrong-arity bug, not a readability gap: keep it open and move it out
of the sweep). Create the umbrella issue, then close the others as
"not planned" pointing at it:

```sh
gh issue create --repo DavidObando/gsharp --label P2 --label gap:readability \
  --title "Post-cut-over cleanup: synthesized identifiers in the translated G# source" \
  --body-file <file listing the swept issues, one per line with its synthetic name, plus the GS0536 redundant-!! warnings>

for n in <swept issue numbers>; do
  gh issue close "$n" --repo DavidObando/gsharp --reason "not planned" \
    --comment "Tracked in #<umbrella>: the source is G# now, so the work is a one-time cleanup of the translated tree, not a cs2gs output gap."
done
```

Keep any issue whose synthetic name is still produced by cs2gs for NEW
translations (monitor it via the cs2gs apps nightly) open as a cs2gs
readability gap.

### One-time cleanup PR

Scope: the 8 synthetic identifiers left in the translated tree and every
`GS0536` redundant-`!!` warning. Find them:

```sh
grep -rnE '__(spill|cast|decon|using|pattern|scrutinee|underscore|local_)' src tools test --include=*.gs | wc -l
dotnet build GSharp.slnx -c Release -graph -p:TreatWarningsAsErrors=false 2>&1 | grep -c GS0536
```

## 3. Repository settings (owner only)

These change what blocks merges. Do them in this order, after the cut-over PR is
merged and `main` is green.

1. Remove the hot-core guard from the required status checks. The workflow job
   `hot-core translation guard` no longer exists, so a required check with that
   name will block every PR forever.

   ```sh
   gh api repos/DavidObando/gsharp/branches/main/protection/required_status_checks --jq '.contexts'
   # remove the one context, keep the rest:
   gh api -X DELETE repos/DavidObando/gsharp/branches/main/protection/required_status_checks/contexts \
     -f 'contexts[]=hot-core translation guard'
   ```

   (If protection is configured via rulesets, edit the ruleset in the UI.)

2. The `nullable-hygiene` job is kept under that name on purpose (it still runs
   the release-version-reference check). Do not remove it from the required
   checks. Renaming it is a separate change: rename the job and the required
   context together.
3. Protect branch `cs2gs/csharp-0.4` (no force pushes, no deletions, admins
   bypass only for back-ports and security fixes):

   ```sh
   gh api -X PUT repos/DavidObando/gsharp/branches/cs2gs%2Fcsharp-0.4/protection \
     --input <protection json file>
   ```

4. Enable the new required check `selfhost-stage2` once ADR-0198 lands its PR
   job (the nightly is not a required check).
5. Create the label the apps nightly files issues under, and remove the two
   retired contexts from the required checks if present:

   ```sh
   gh label create cs2gs-nightly --repo DavidObando/gsharp --color 5319E7 \
     --description "Filed automatically by cs2gs-apps-nightly"
   gh api repos/DavidObando/gsharp/branches/main/protection/required_status_checks --jq '.contexts'
   gh api -X DELETE repos/DavidObando/gsharp/branches/main/protection/required_status_checks/contexts \
     -f 'contexts[]=cs2gs-oahu' -f 'contexts[]=cs2gs-code-exploder'
   ```
6. Run the nightly stage-2 job and the apps nightly on the merged head:

   ```sh
   gh workflow run selfhost-stage2-nightly.yml --repo DavidObando/gsharp --ref main
   gh workflow run cs2gs-apps-nightly.yml --repo DavidObando/gsharp --ref main
   ```
