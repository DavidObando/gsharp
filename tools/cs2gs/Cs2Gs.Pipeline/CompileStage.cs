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
        string outputPath = Path.Combine(context.AppRunDir, outputName);

        IReadOnlyList<string> gsFiles = OrderForCompilation(context.EmittedFiles)
            .Select(f => f.GsPath)
            .ToList();
        GscResult result = context.Gsc.Compile(
            gsFiles,
            outputPath,
            context.App.TargetKind,
            BuildReferenceSet(context.App.ReferencedAssemblies, context.ExternalReferencePaths),
            context.AnalyzerReferencePaths,
            context.AdditionalGeneratorFiles,
            context.GeneratorGlobalOptions);

        File.WriteAllText(
            Path.Combine(context.AppRunDir, "gsc.compile.log"),
            result.Output ?? string.Empty);

        if (result.Succeeded)
        {
            // Publish the emitted assembly path for the downstream IL-verify stage.
            context.EmittedAssemblyPath = outputPath;
            return Task.FromResult(StageOutcome.Passed());
        }

        var artifacts = new List<TriageArtifact>();
        foreach (GscDiagnostic diagnostic in result.Errors)
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
        // compiled cleanly. gsc still produced no assembly (the whole
        // compilation failed), so IL-verify simply has nothing to read.
        if (artifacts.Count == 0 && result.Errors.Count > 0)
        {
            return Task.FromResult(StageOutcome.Passed());
        }

        // Exit was non-zero but no structured GSxxxx error was parsed (e.g. a
        // crash). Capture a synthetic compile-error so the failure is not lost.
        if (artifacts.Count == 0)
        {
            string message = "gsc exited with code " + result.ExitCode +
                " and no parseable diagnostic. Output: " + Truncate(result.Output);
            var synthetic = new GscDiagnostic(
                "GS9999",
                message,
                "error",
                context.EmittedFiles[0].RelativeGsPath,
                1,
                1);
            artifacts.Add(context.Triage.CompileError(synthetic, context.EmittedFiles[0]));
        }

        return Task.FromResult(StageOutcome.Failed(artifacts));
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

    /// <summary>
    /// Orders emitted files so that a file declaring a base class is compiled
    /// before any file declaring its subclasses. gsc currently resolves a
    /// <c>: base(...)</c> constructor chain against the base class's explicit
    /// <c>init</c> only when the base type has already been bound, so a derived
    /// class that appears before its base reports a spurious GS0214 "no
    /// accessible constructor" (and cascading GS0183/GS0187). A stable
    /// topological sort on the class-inheritance graph avoids that; cycles (which
    /// the inheritance graph cannot contain, but file-level grouping might) fall
    /// back to the original order.
    /// </summary>
    private static IReadOnlyList<EmittedGsFile> OrderForCompilation(IReadOnlyList<EmittedGsFile> files)
    {
        if (files.Count <= 1)
        {
            return files;
        }

        // Map each declared type's simple name to the file that declares it.
        var typeToFile = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < files.Count; i++)
        {
            foreach (string typeName in files[i].DeclaredTypeNames)
            {
                typeToFile.TryAdd(typeName, i);
            }
        }

        // Edges: a file depends on (must come after) every file that declares one
        // of its base classes.
        var dependencies = new List<HashSet<int>>(files.Count);
        var dependentCount = new int[files.Count];
        for (int i = 0; i < files.Count; i++)
        {
            dependencies.Add(new HashSet<int>());
        }

        for (int i = 0; i < files.Count; i++)
        {
            foreach (string baseName in files[i].BaseClassNames)
            {
                if (typeToFile.TryGetValue(baseName, out int baseFile) &&
                    baseFile != i &&
                    dependencies[i].Add(baseFile))
                {
                    dependentCount[i]++;
                }
            }
        }

        // Kahn's algorithm with stable tie-breaking by original index.
        var ordered = new List<EmittedGsFile>(files.Count);
        var emitted = new bool[files.Count];
        int remaining = files.Count;
        while (remaining > 0)
        {
            int picked = -1;
            for (int i = 0; i < files.Count; i++)
            {
                if (!emitted[i] && dependentCount[i] == 0)
                {
                    picked = i;
                    break;
                }
            }

            if (picked < 0)
            {
                // Cycle in the file-level graph: emit the remaining files in their
                // original order to make progress.
                for (int i = 0; i < files.Count; i++)
                {
                    if (!emitted[i])
                    {
                        ordered.Add(files[i]);
                        emitted[i] = true;
                    }
                }

                break;
            }

            ordered.Add(files[picked]);
            emitted[picked] = true;
            remaining--;
            for (int i = 0; i < files.Count; i++)
            {
                if (!emitted[i] && dependencies[i].Remove(picked))
                {
                    dependentCount[i]--;
                }
            }
        }

        return ordered;
    }

    private static EmittedGsFile MatchEmittedFile(IReadOnlyList<EmittedGsFile> files, string diagnosticFile)
    {
        if (!string.IsNullOrEmpty(diagnosticFile))
        {
            string name = Path.GetFileName(diagnosticFile);
            EmittedGsFile match = files.FirstOrDefault(f =>
                string.Equals(Path.GetFileName(f.GsPath), name, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                return match;
            }
        }

        return files.Count == 1 ? files[0] : null;
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
