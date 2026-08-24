// <copyright file="CompileStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Stage 2 (ADR-0115 §C): compile the emitted G# set with the real <c>gsc</c>.
/// Pass gate: exit 0 AND zero error-severity <c>GSxxxx</c> diagnostics. On
/// failure the category is <c>compile-error</c>, one triage artifact per
/// distinct error diagnostic, and the app short-circuits.
/// </summary>
public sealed class CompileStage : IMigrationStage
{
    /// <inheritdoc/>
    public MigrationStageKind Kind => MigrationStageKind.Compile;

    /// <inheritdoc/>
    public Task<StageOutcome> ExecuteAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken = default)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        if (context.EmittedFiles.Count == 0)
        {
            return Task.FromResult(StageOutcome.Passed());
        }

        string outputName = Path.GetFileNameWithoutExtension(context.App.ProjectPath) + ".dll";
        string outputPath = Path.Combine(context.ArtifactDir, outputName);

        IReadOnlyList<string> gsFiles = context.EmittedFiles
            .Select(f => f.GsPath)
            .ToList();
        IReadOnlyList<string> references =
            BuildReferenceSet(context.App.ReferencedAssemblies, context.ExternalReferencePaths);

        if (context.Options.CompileViaSdk)
        {
            var runner = new SdkCompileRunner();
            SdkCompileResult RunSdkCompile() =>
                context.Options.OutputLayout == MigrationOutputLayout.Repository
                    ? runner.CompileMirroredProject(
                        context.App.ProjectPath,
                        context.Options.GeneratedProjectPaths[Path.GetFullPath(context.App.ProjectPath)],
                        context.ArtifactDir,
                        context.Options.Config,
                        context.Options.GeneratedProjectPaths)
                    : runner.Compile(
                        context.ProjectOutputDir,
                        Path.GetFileNameWithoutExtension(context.App.ProjectPath),
                        gsFiles,
                        context.App.TargetKind,
                        references,
                        context.AnalyzerReferencePaths,
                        context.AdditionalGeneratorFiles,
                        context.RootNamespace,
                        context.Options.Config,
                        context.BuildOnlyPackageReferences,
                        context.PackageReferences,
                        context.ProjectReferences,
                        context.Options.GeneratedProjectPaths,
                        context.UsesCentralPackageManagement,
                        assemblyName: context.AssemblyName);

            SdkCompileResult sdkResult = RunSdkCompile();

            // Issue #3501 (!! reduction): gsc reports GS0536 on every `!!`
            // whose operand is already non-null — the compiler's own
            // narrowing is the single source of truth. Strip exactly those
            // spans from the emitted files and recompile once so the shipped
            // output carries no redundant assertions. Defensive: if the
            // polished recompile somehow regresses a previously passing
            // build, restore the original text and keep the first result.
            if (sdkResult.IsAvailable
                && sdkResult.Diagnostics.Any(d => d.Id == NullAssertionPolishPass.DiagnosticId))
            {
                // The SDK build also compiles project references, so a
                // dependency whose own compile stage never ran can surface
                // GS0536 in files outside this app's emitted set — anything
                // under the shared output root is fair game for the polish.
                string strippableRoot = context.Options.OutputRoot;
                Dictionary<string, string> backups = NullAssertionPolishPass
                    .CandidateFiles(sdkResult.Diagnostics, gsFiles, strippableRoot)
                    .Concat(gsFiles)
                    .Where(File.Exists)
                    .Distinct(StringComparer.Ordinal)
                    .ToDictionary(f => f, File.ReadAllText, StringComparer.Ordinal);
                if (NullAssertionPolishPass.Strip(sdkResult.Diagnostics, gsFiles, strippableRoot) > 0)
                {
                    SdkCompileResult polished = RunSdkCompile();
                    if (polished.IsAvailable && (polished.Succeeded || !sdkResult.Succeeded))
                    {
                        sdkResult = polished;
                    }
                    else
                    {
                        foreach (KeyValuePair<string, string> backup in backups)
                        {
                            File.WriteAllText(backup.Key, backup.Value);
                        }
                    }
                }
            }

            if (sdkResult.IsAvailable)
            {
                if (sdkResult.Succeeded)
                {
                    context.EmittedAssemblyPath = sdkResult.EmittedAssemblyPath;
                    return Task.FromResult(StageOutcome.Passed());
                }

                string sdkSyntheticMessage = "dotnet build (--via-sdk) exited with code " + sdkResult.ExitCode +
                    " and no parseable diagnostic. Output: " + Truncate(sdkResult.Output);
                return Task.FromResult(BuildFailureOutcome(context, sdkResult.Errors, sdkSyntheticMessage));
            }

            string unavailableMessage = "dotnet build (--via-sdk) is unavailable: " +
                sdkResult.UnavailableReason +
                " Pass --no-via-sdk to explicitly use the legacy direct-gsc path.";
            return Task.FromResult(BuildFailureOutcome(
                context,
                Array.Empty<GscDiagnostic>(),
                unavailableMessage));
        }

        GscResult result = context.Gsc.Compile(
            gsFiles,
            outputPath,
            context.App.TargetKind,
            references,
            context.AnalyzerReferencePaths,
            context.AdditionalGeneratorFiles,
            context.GeneratorGlobalOptions);

        File.WriteAllText(
            Path.Combine(context.ArtifactDir, "gsc.compile.log"),
            result.Output ?? string.Empty);

        if (result.Succeeded)
        {
            // Publish the emitted assembly path for the downstream IL-verify stage.
            context.EmittedAssemblyPath = outputPath;
            return Task.FromResult(StageOutcome.Passed());
        }

        string syntheticMessage = "gsc exited with code " + result.ExitCode +
            " and no parseable diagnostic. Output: " + Truncate(result.Output);
        return Task.FromResult(BuildFailureOutcome(context, result.Errors, syntheticMessage));
    }

    /// <summary>
    /// Maps a set of parsed error-severity diagnostics into triage artifacts,
    /// shared by both the gsc-direct and <c>--via-sdk</c> compile paths.
    /// </summary>
    /// <summary>
    /// Resolves the <c>.gs</c> file a gsc diagnostic points at, so the triage
    /// artifact can quote the emitted line (see <c>TriageBuilder.CompileError</c>).
    /// </summary>
    /// <remarks>
    /// Matching has to cope with two diagnostic shapes. Direct gsc invocation
    /// reports an absolute path; the <c>--via-sdk</c> path routes through MSBuild,
    /// which may report a path relative to the project directory and appends a
    /// <c>[project.gsproj]</c> suffix that the parser leaves on the MESSAGE, not
    /// the file.
    /// <para>
    /// Issue #3347: a basename collision across sibling projects — common in a
    /// repository-layout run, where <c>EmittedFiles</c> also carries referenced
    /// projects' files — used to make the ambiguous case return null, which
    /// silently degraded every downstream field. The app's OWN files are now
    /// preferred before falling back to siblings.
    /// </para>
    /// </remarks>
    /// <param name="files">The emitted files for this app, plus referenced siblings.</param>
    /// <param name="diagnosticFile">The file path as reported by gsc or MSBuild.</param>
    /// <returns>The matching file, or <see langword="null"/> when it cannot be resolved.</returns>
    internal static EmittedGsFile MatchEmittedFile(IReadOnlyList<EmittedGsFile> files, string diagnosticFile)
    {
        if (files is null || files.Count == 0)
        {
            return null;
        }

        if (!string.IsNullOrEmpty(diagnosticFile))
        {
            string diagnosticFullPath = Path.GetFullPath(diagnosticFile);
            EmittedGsFile exactMatch = files.FirstOrDefault(f =>
                string.Equals(Path.GetFullPath(f.GsPath), diagnosticFullPath, StringComparison.OrdinalIgnoreCase));
            if (exactMatch is not null)
            {
                return exactMatch;
            }

            // A relative path from MSBuild resolves against cs2gs's working
            // directory above, which is not the project directory — so compare
            // path SUFFIXES too. `/a/b/Foo/Bar.gs` matches a reported `Foo/Bar.gs`.
            string normalizedDiagnostic = NormalizeSeparators(diagnosticFile);
            EmittedGsFile[] suffixMatches = files
                .Where(f => NormalizeSeparators(f.GsPath)
                    .EndsWith(normalizedDiagnostic, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            EmittedGsFile suffixMatch = PreferOwnProject(suffixMatches);
            if (suffixMatch is not null)
            {
                return suffixMatch;
            }

            string name = Path.GetFileName(diagnosticFile);
            EmittedGsFile[] matches = files.Where(f =>
                string.Equals(Path.GetFileName(f.GsPath), name, StringComparison.OrdinalIgnoreCase)).ToArray();
            EmittedGsFile nameMatch = PreferOwnProject(matches);
            if (nameMatch is not null)
            {
                return nameMatch;
            }
        }

        return files.Count == 1 ? files[0] : null;
    }

    // A basename can collide across sibling projects. The app's own files are the
    // only ones charged against it (a sibling's error is measured in its own run),
    // so prefer those; a remaining ambiguity is genuinely unresolvable.
    private static EmittedGsFile PreferOwnProject(EmittedGsFile[] candidates)
    {
        if (candidates.Length == 1)
        {
            return candidates[0];
        }

        EmittedGsFile[] own = candidates.Where(f => !f.IsFromReferencedProject).ToArray();
        return own.Length == 1 ? own[0] : null;
    }

    private static string NormalizeSeparators(string path) =>
        path.Replace('\\', '/');

    private static StageOutcome BuildFailureOutcome(
        StageExecutionContext context, IReadOnlyList<GscDiagnostic> errors, string syntheticMessageOnNoDiagnostics)
    {
        var artifacts = new List<TriageArtifact>();
        foreach (GscDiagnostic diagnostic in errors)
        {
            EmittedGsFile file = MatchEmittedFile(context.EmittedFiles, diagnostic.File);

            // Errors located in a referenced sibling project's emitted file are
            // that project's own concern (measured in its own run), not charged
            // against this app. Sibling files are compile inputs only, so the
            // app's uses of sibling types resolve (Refs #914).
            if (file is not null && file.IsFromReferencedProject)
            {
                continue;
            }

            artifacts.Add(context.Triage.CompileError(diagnostic, file));
        }

        // Every parsed error was in a referenced sibling file: the app's own G#
        // compiled cleanly. The whole compilation still produced no assembly,
        // so IL-verify simply has nothing to read.
        if (artifacts.Count == 0 && errors.Count > 0)
        {
            return StageOutcome.Passed();
        }

        // Exit was non-zero but no structured GSxxxx error was parsed (e.g. a
        // crash). Capture a synthetic compile-error so the failure is not lost.
        if (artifacts.Count == 0)
        {
            var synthetic = new GscDiagnostic(
                "GS9999",
                syntheticMessageOnNoDiagnostics,
                "error",
                context.EmittedFiles[0].RelativeGsPath,
                1,
                1);
            artifacts.Add(context.Triage.CompileError(synthetic, context.EmittedFiles[0]));
        }

        return StageOutcome.Failed(artifacts);
    }

    /// <summary>
    /// Builds the full <c>/reference:</c> set passed to <c>gsc</c>. gsc's
    /// <c>WithReferences</c> resolver projects every referenced CLR type through
    /// an isolated <c>MetadataLoadContext</c> seeded from the supplied paths, so
    /// a partial BCL set leaves core types (even <c>System.Int32</c>)
    /// unresolvable. The emitted G# also imports namespaces such as
    /// <c>System.Threading.Channels</c> and <c>System.Memory</c> that the gsc
    /// host does not load by default. Passing the complete shared-framework
    /// assembly set makes every framework type (including <c>Channel</c> /
    /// <c>Span</c>) resolvable while keeping the app's own sibling references.
    /// </summary>
    /// <param name="appReferences">The app's sibling assembly references.</param>
    /// <param name="externalReferences">
    /// External (NuGet package) assembly paths captured from the C# compilation
    /// by the Translate stage. Any whose file name matches a framework assembly
    /// is skipped to avoid ref-pack / runtime double-identity; the rest let
    /// package types (e.g. <c>System.Management</c>) resolve (Refs #914).
    /// </param>
    /// <returns>The deduplicated reference path set.</returns>
    private static IReadOnlyList<string> BuildReferenceSet(
        IReadOnlyList<string> appReferences,
        IReadOnlyList<string> externalReferences = null)
    {
        var references = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (appReferences is not null)
        {
            foreach (string reference in appReferences)
            {
                if (!string.IsNullOrWhiteSpace(reference) && seen.Add(reference))
                {
                    references.Add(reference);
                }
            }
        }

        var frameworkFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string frameworkReference in FrameworkReferencePaths())
        {
            frameworkFileNames.Add(Path.GetFileName(frameworkReference));
            if (seen.Add(frameworkReference))
            {
                references.Add(frameworkReference);
            }
        }

        if (externalReferences is not null)
        {
            foreach (string reference in externalReferences)
            {
                if (string.IsNullOrWhiteSpace(reference) || !seen.Add(reference))
                {
                    continue;
                }

                // Skip package copies of framework assemblies to avoid the
                // gsc MetadataLoadContext resolving two identities for the same
                // assembly (the shared-framework version already covers them).
                if (frameworkFileNames.Contains(Path.GetFileName(reference)))
                {
                    continue;
                }

                references.Add(reference);
            }
        }

        return references;
    }

    /// <summary>
    /// Enumerates the shared-framework assemblies for the running runtime (the
    /// <c>Microsoft.NETCore.App</c> directory). This is the same shared framework
    /// the out-of-process <c>gsc</c> resolves against, so the paths are valid for
    /// the compiler subprocess.
    /// </summary>
    /// <returns>The absolute paths of the shared-framework assemblies.</returns>
    private static IReadOnlyList<string> FrameworkReferencePaths()
    {
        string runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();
    }

    private static string Truncate(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        string oneLine = value.Replace("\r", " ").Replace("\n", " ").Trim();
        return oneLine.Length <= 200 ? oneLine : oneLine.Substring(0, 200);
    }
}
