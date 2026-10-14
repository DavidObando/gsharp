// <copyright file="CompileStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import GSharp.Core.CodeAnalysis
import System.Runtime.InteropServices
import System.Xml.Linq

/// Stage 2 (ADR-0115 §C): compile the emitted G# set with the real `gsc`.
/// Pass gate: exit 0 AND zero error-severity `GSxxxx` diagnostics. On
/// failure the category is `compile-error`, one triage artifact per
/// distinct error diagnostic, and the app short-circuits.
class CompileStage : IMigrationStage {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Kind MigrationStageKind -> MigrationStageKind.Compile

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func ExecuteAsync(
        context StageExecutionContext?,
        cancellationToken CancellationToken = default(CancellationToken)
    ) Task[StageOutcome] {
        if context == nil {
            throw ArgumentNullException("context")
        }
        if context.EmittedFiles.Count == 0 {
            return Task.FromResult(StageOutcome.Passed())
        }
        let outputName = Path.GetFileNameWithoutExtension(context.App.ProjectPath) + ".dll"
        let outputPath = Path.Combine(context.ArtifactDir, outputName)
        let gsFiles IReadOnlyList[string] = context.EmittedFiles.Select((f EmittedGsFile) -> f.GsPath!!).ToList()
        var references = BuildReferenceSet(context.App.ReferencedAssemblies, context.ExternalReferencePaths)
        var buildOnlyPackageReferences IReadOnlyList[DeclaredPackageReference] = context.BuildOnlyPackageReferences
        var packageReferences IReadOnlyList[DeclaredProjectItem] = context.PackageReferences
        if context.IsAnalyzerProject {
            references = references
                .Where(
                (path string) -> !Path.GetFileName(path).StartsWith(
                    "Microsoft.CodeAnalysis",
                    StringComparison.OrdinalIgnoreCase
                )
            )
                .Append(typeof(Diagnostic).Assembly.Location)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList()
            buildOnlyPackageReferences = buildOnlyPackageReferences.Where(
                (reference DeclaredPackageReference) -> !reference.Id.StartsWith(
                    "Microsoft.CodeAnalysis",
                    StringComparison.OrdinalIgnoreCase
                )
            )
                .ToList()
            packageReferences = packageReferences.Where(
                (reference DeclaredProjectItem) -> reference
                    .Element
                    .Attribute(XName?("Include")!!)
                    ?.Value
                    ?.StartsWith("Microsoft.CodeAnalysis", StringComparison.OrdinalIgnoreCase) != true
            )
                .ToList()
        }
        if context.Options.CompileViaSdk {
            let runner = SdkCompileRunner()
            // Issue #3782: `survey` demotes GS0536 to a warning for this build
            // only, so one compile walks the WHOLE project graph and reports
            // every redundant `!!` in it. Without it a warnings-as-errors build
            // stops at the first project holding one and the polish loop
            // advances a single project per round. The gate's verdict always
            // comes from a survey: false build.
            let RunSdkCompile = func (survey bool) SdkCompileResult {
                return if context.Options.OutputLayout == MigrationOutputLayout.Repository {
                    runner.CompileMirroredProject(
                        context.App.ProjectPath,
                        context.Options.GeneratedProjectPaths!![Path.GetFullPath(context.App.ProjectPath)],
                        context.ArtifactDir,
                        context.Options.Config,
                        context.Options.GeneratedProjectPaths,
                        context.IsAnalyzerTestProject,
                        context.Options.RepositorySdkMoniker,
                        context.Options.RepositoryAnalyzerVerifierPackageVersion,
                        if survey {
                            NullAssertionPolishPass.SurveyWarningsNotAsErrors
                        } else {
                            default(string?)
                        }
                    )
                } else {
                    runner.Compile(
                        context.ProjectOutputDir,
                        Path.GetFileNameWithoutExtension(context.App.ProjectPath),
                        gsFiles,
                        context.App.TargetKind,
                        references,
                        context.AnalyzerReferencePaths,
                        context.AdditionalGeneratorFiles,
                        context.RootNamespace,
                        context.Options.Config,
                        buildOnlyPackageReferences,
                        packageReferences,
                        context.ProjectReferences,
                        context.Options.GeneratedProjectPaths,
                        context.UsesCentralPackageManagement,
                        assemblyName: context.AssemblyName,
                        warningsNotAsErrors: if survey {
                            NullAssertionPolishPass.SurveyWarningsNotAsErrors
                        } else {
                            default(string?)
                        }
                    )
                }
            }
            var sdkResult SdkCompileResult? = RunSdkCompile(survey: false)
            // Issue #3501 (!! reduction): gsc reports GS0536 on every `!!`
            // whose operand is already non-null — the compiler's own
            // narrowing is the single source of truth. Strip exactly those
            // spans from the emitted files and recompile, repeating until a
            // compile stops reporting them.
            //
            // Issue #3723: this used to stop after three rounds, which is not
            // a fixed point. A compile reports nothing past the first project
            // it fails on, so a deep reference graph spends a round per level
            // before the app's own sources are ever bound; nested assertions
            // (`a!!.b!!`) then add generations on top. Four apps were red on
            // the nightly gate with GS0536 as their ONLY diagnostic because
            // the loop ran out of rounds and said nothing about it.
            //
            // The SDK build also compiles project references, so a dependency
            // whose own compile stage never ran can surface GS0536 in files
            // outside this app's emitted set — anything under the shared
            // output root is fair game for the polish.
            //
            // Issue #3782: raising the cap was the wrong lever — one round per
            // project is a ~40-build bill for `tools/cs2gs/Cs2Gs.Tests` and its
            // twelve-project graph, and it made the corpus-wide `!!` count
            // depend on how the gate happened to pack its shards. The rounds
            // after the first now SURVEY (GS0536 demoted to a warning) so a
            // single build reports the whole graph at once; the loop then ends
            // on a strict build, which is the verdict below.
            let polish = NullAssertionPolishPass.RunToFixedPoint(
                sdkResult,
                RunSdkCompile,
                gsFiles,
                context.Options.OutputRoot
            )
            sdkResult = polish.Result
            ReportPolishOutcome(context, polish)
            if sdkResult.IsAvailable {
                if sdkResult.Succeeded {
                    context.EmittedAssemblyPath = sdkResult.EmittedAssemblyPath
                    return Task.FromResult(StageOutcome.Passed())
                }
                // Issue #3905: a compiler CRASH and a mis-parsed diagnostic
                // reach this line looking identical — "exited with code 1 and
                // no parseable diagnostic" — and the first one cost a whole
                // investigation through raw sdk.build.log to tell apart. When
                // the build output carries a managed crash signature, say so.
                let crash = DescribeCompilerCrash(sdkResult.Output)
                let sdkSyntheticMessage = "dotnet build (--via-sdk) exited with code " + sdkResult.ExitCode.ToString() +
                    " and no parseable diagnostic." +
                    crash +
                    " Output: " +
                    Truncate(sdkResult.Output)
                return Task.FromResult(BuildFailureOutcome(context, sdkResult.Errors, sdkSyntheticMessage))
            }
            let unavailableMessage = "dotnet build (--via-sdk) is unavailable: " +
                sdkResult.UnavailableReason +
                " Pass --no-via-sdk to explicitly use the legacy direct-gsc path."
            return Task.FromResult(BuildFailureOutcome(context, Array.Empty[GscDiagnostic](), unavailableMessage))
        }
        let result = context.Gsc.Compile(
            gsFiles,
            outputPath,
            context.App.TargetKind,
            references,
            context.AnalyzerReferencePaths,
            context.AdditionalGeneratorFiles,
            context.GeneratorGlobalOptions
        )
        File.WriteAllText(Path.Combine(context.ArtifactDir, "gsc.compile.log"), result.Output ?? string.Empty)
        if result.Succeeded {
            // Publish the emitted assembly path for the downstream IL-verify stage.
            context.EmittedAssemblyPath = outputPath
            return Task.FromResult(StageOutcome.Passed())
        }
        let syntheticMessage = "gsc exited with code " + result.ExitCode.ToString() +
            " and no parseable diagnostic. Output: " +
            Truncate(result.Output)
        return Task.FromResult(BuildFailureOutcome(context, result.Errors, syntheticMessage))
    }

    shared {
        /// Maps a set of parsed error-severity diagnostics into triage artifacts,
        /// shared by both the gsc-direct and `--via-sdk` compile paths.
        ///
        /// Resolves the `.gs` file a gsc diagnostic points at, so the triage
        /// artifact can quote the emitted line (see `TriageBuilder.CompileError`).
        /// @remarks Matching has to cope with two diagnostic shapes. Direct gsc invocation
        /// reports an absolute path; the `--via-sdk` path routes through MSBuild,
        /// which may report a path relative to the project directory and appends a
        /// `[project.gsproj]` suffix that the parser leaves on the MESSAGE, not
        /// the file.
        ///
        /// Issue #3347: a basename collision across sibling projects — common in a
        /// repository-layout run, where `EmittedFiles` also carries referenced
        /// projects' files — used to make the ambiguous case return null, which
        /// silently degraded every downstream field. The app's OWN files are now
        /// preferred before falling back to siblings.
        /// @param files The emitted files for this app, plus referenced siblings.
        /// @param diagnosticFile The file path as reported by gsc or MSBuild.
        /// @returns The matching file, or `null` when it cannot be resolved.
        internal func MatchEmittedFile(files IReadOnlyList[EmittedGsFile]?, diagnosticFile string) EmittedGsFile? {
            if files == nil || files.Count == 0 {
                return nil
            }
            if !string.IsNullOrEmpty(diagnosticFile) {
                let diagnosticFullPath = Path.GetFullPath(diagnosticFile)
                let exactMatch EmittedGsFile? = files.FirstOrDefault(
                    (f EmittedGsFile) -> string.Equals(
                        Path.GetFullPath(f.GsPath!!),
                        diagnosticFullPath,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                if exactMatch != nil {
                    return exactMatch
                }
                // A relative path from MSBuild resolves against cs2gs's working
                // directory above, which is not the project directory — so compare
                // path SUFFIXES too. `/a/b/Foo/Bar.gs` matches a reported `Foo/Bar.gs`.
                let normalizedDiagnostic = NormalizeSeparators(diagnosticFile)
                let suffixMatches = files.Where(
                    (f EmittedGsFile) -> NormalizeSeparators(f.GsPath).EndsWith(
                        normalizedDiagnostic,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                    .ToArray()
                let suffixMatch EmittedGsFile? = PreferOwnProject(suffixMatches)
                if suffixMatch != nil {
                    return suffixMatch
                }
                let name = Path.GetFileName(diagnosticFile)
                let matches = files.Where(
                    (f EmittedGsFile) -> string.Equals(
                        Path.GetFileName(f.GsPath),
                        name,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                    .ToArray()
                let nameMatch EmittedGsFile? = PreferOwnProject(matches)
                if nameMatch != nil {
                    return nameMatch
                }
            }
            return if files.Count == 1 {
                files[0]
            } else {
                default(EmittedGsFile?)
            }
        }

        // A basename can collide across sibling projects. The app's own files are the
        // only ones charged against it (a sibling's error is measured in its own run),
        // so prefer those; a remaining ambiguity is genuinely unresolvable.
        private func PreferOwnProject(candidates[]EmittedGsFile) EmittedGsFile? {
            if candidates.Length == 1 {
                return candidates[0]
            }
            let own = candidates.Where((f EmittedGsFile) -> !f.IsFromReferencedProject).ToArray()
            return if own.Length == 1 {
                own[0]
            } else {
                default(EmittedGsFile?)
            }
        }

        private func NormalizeSeparators(path string?) string -> path!!.Replace('\\', '/')

        /// Issue #3723: records what the redundant-`!!` polish loop did, and
        /// says so on stderr when it stopped short of a fixed point. Silently
        /// giving up is how the non-convergence stayed invisible across several
        /// nightly runs, so an app that is still reporting GS0536 after the loop
        /// now always leaves a trace next to its build log.
        /// @param context The stage context (for the artifact directory and app id).
        /// @param polish The loop outcome.
        private func ReportPolishOutcome(
            context StageExecutionContext,
            polish NullAssertionPolishPass.PolishLoopOutcome
        ) {
            if polish.Rounds == 0 {
                return
            }
            // Issue #3782: `builds` is the cost the gate actually pays (the strip
            // recompiles plus the closing strict confirmation); it stopped equalling
            // `rounds` when survey mode landed, so both are recorded.
            let summary = "polish rounds: ${polish.Rounds} (cap ${NullAssertionPolishPass.DefaultMaxRounds}), " +
                "polish builds: ${polish.Builds}, " +
                "assertions stripped: ${polish.Stripped}, " +
                "${NullAssertionPolishPass.DiagnosticId} still reported: ${polish.RemainingReports}, " +
                "cap exhausted: ${polish.CapExhausted}"
            try {
                Directory.CreateDirectory(context.ArtifactDir)
                File.WriteAllText(Path.Combine(context.ArtifactDir, "polish.log"), summary + Environment.NewLine)
            } catch (e Exception) when e is IOException || e is UnauthorizedAccessException {
                // The artifact is advisory; never fail the stage over it.

            }
            if polish.RemainingReports > 0 {
                Console.Error.WriteLine(
                    "cs2gs: ${context.App.Id}: the redundant-'!!' polish pass did not converge — $summary."
                )
            }
        }

        private func BuildFailureOutcome(
            context StageExecutionContext,
            errors IReadOnlyList[GscDiagnostic],
            syntheticMessageOnNoDiagnostics string
        ) StageOutcome {
            let artifacts = List[TriageArtifact]()
            for diagnostic in errors {
                let file EmittedGsFile? = MatchEmittedFile(context.EmittedFiles, diagnostic.File)
                // Errors located in a referenced sibling project's emitted file are
                // that project's own concern (measured in its own run), not charged
                // against this app. Sibling files are compile inputs only, so the
                // app's uses of sibling types resolve (Refs #914).
                if file != nil && file.IsFromReferencedProject {
                    continue
                }
                artifacts.Add(context.Triage.CompileError(diagnostic, file))
            }
            // Every parsed error was in a referenced sibling file: the app's own G#
            // compiled cleanly. The whole compilation still produced no assembly,
            // so IL-verify simply has nothing to read.
            if artifacts.Count == 0 && errors.Count > 0 {
                return StageOutcome.Passed()
            }
            // Exit was non-zero but no structured GSxxxx error was parsed (e.g. a
            // crash). Capture a synthetic compile-error so the failure is not lost.
            if artifacts.Count == 0 {
                let synthetic = GscDiagnostic(
                    "GS9999",
                    syntheticMessageOnNoDiagnostics,
                    "error",
                    context.EmittedFiles[0].RelativeGsPath,
                    1,
                    1
                )
                artifacts.Add(context.Triage.CompileError(synthetic, context.EmittedFiles[0]))
            }
            return StageOutcome.Failed(artifacts)
        }

        /// Builds the full `/reference:` set passed to `gsc`. gsc's
        /// `WithReferences` resolver projects every referenced CLR type through
        /// an isolated `MetadataLoadContext` seeded from the supplied paths, so
        /// a partial BCL set leaves core types (even `System.Int32`)
        /// unresolvable. The emitted G# also imports namespaces such as
        /// `System.Threading.Channels` and `System.Memory` that the gsc
        /// host does not load by default. Passing the complete shared-framework
        /// assembly set makes every framework type (including `Channel` /
        /// `Span`) resolvable while keeping the app's own sibling references.
        /// @param appReferences The app's sibling assembly references.
        /// @param externalReferences External (NuGet package) assembly paths captured from the C# compilation
        /// by the Translate stage. Any whose file name matches a framework assembly
        /// is skipped to avoid ref-pack / runtime double-identity; the rest let
        /// package types (e.g. `System.Management`) resolve (Refs #914).
        /// @returns The deduplicated reference path set.
        private func BuildReferenceSet(
            appReferences IReadOnlyList[string]?,
            externalReferences IReadOnlyList[string]? = nil
        ) IReadOnlyList[string] {
            let references = List[string]()
            let seen = HashSet[string](StringComparer.OrdinalIgnoreCase)
            if appReferences != nil {
                for reference in appReferences {
                    if !string.IsNullOrWhiteSpace(reference) && seen.Add(reference) {
                        references.Add(reference)
                    }
                }
            }
            let frameworkFileNames = HashSet[string](StringComparer.OrdinalIgnoreCase)
            for frameworkReference in FrameworkReferencePaths() {
                frameworkFileNames.Add(Path.GetFileName(frameworkReference))
                if seen.Add(frameworkReference) {
                    references.Add(frameworkReference)
                }
            }
            if externalReferences != nil {
                for reference in externalReferences {
                    if string.IsNullOrWhiteSpace(reference) || !seen.Add(reference) {
                        continue
                    }
                    // Skip package copies of framework assemblies to avoid the
                    // gsc MetadataLoadContext resolving two identities for the same
                    // assembly (the shared-framework version already covers them).
                    if frameworkFileNames.Contains(Path.GetFileName(reference)) {
                        continue
                    }
                    references.Add(reference)
                }
            }
            return references
        }

        /// Enumerates the shared-framework assemblies for the running runtime (the
        /// `Microsoft.NETCore.App` directory). This is the same shared framework
        /// the out-of-process `gsc` resolves against, so the paths are valid for
        /// the compiler subprocess.
        /// @returns The absolute paths of the shared-framework assemblies.
        private func FrameworkReferencePaths() IReadOnlyList[string] {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                return Array.Empty[string]()
            }
            return Directory
                .EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
                .OrderBy((p string) -> p, StringComparer.Ordinal)
                .ToList()
        }

        /// Issue #3905: recognises a compiler process that DIED rather than
        /// reported. A stack overflow cannot be caught, so gsc leaves nothing but
        /// "Stack overflow." and a managed stack trace on stdout and exits
        /// non-zero — which the diagnostic parser reads as "no diagnostics", the
        /// same shape a mis-parsed error line produces. Naming the crash (and the
        /// first compiler frame beneath it) in the synthetic message turns a
        /// dig through raw sdk.build.log into a line of gate output.
        /// @param output The captured build output.
        /// @returns A leading-space-prefixed sentence, or the empty string when the output shows no crash.
        private func DescribeCompilerCrash(output string?) string {
            if string.IsNullOrEmpty(output) {
                return string.Empty
            }
            var kind string? = nil
            if output.Contains("Stack overflow.") {
                kind = "stack overflow"
            } else if output.Contains("Unhandled exception.") {
                kind = "unhandled exception"
            }
            if kind == nil {
                return string.Empty
            }
            // The first compiler frame names the recursion/fault site, which is the
            // one thing a reader needs before opening the log.
            var frame string? = nil
            for rawLine in output.Replace("\r\n", "\n").Split('\n') {
                let line = rawLine.Trim()
                if line.StartsWith("at GSharp.", StringComparison.Ordinal) {
                    frame = line
                    break
                }
            }
            let where = if frame == nil {
                string.Empty
            } else {
                " First compiler frame: " + Truncate(frame) + "."
            }
            return " THE COMPILER CRASHED (" +
                kind +
                ") — this is a gsc bug, not a translation error;" +
                " no diagnostics exist because the process died." +
                where
        }

        private func Truncate(value string?) string {
            if string.IsNullOrEmpty(value) {
                return string.Empty
            }
            let oneLine = value.Replace("\r", " ").Replace("\n", " ").Trim()
            return if oneLine.Length <= 200 {
                oneLine
            } else {
                oneLine.Substring(0, 200)
            }
        }
    }
}
