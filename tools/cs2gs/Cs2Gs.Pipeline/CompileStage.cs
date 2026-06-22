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

        IReadOnlyList<string> gsFiles = context.EmittedFiles.Select(f => f.GsPath).ToList();
        GscResult result = context.Gsc.Compile(
            gsFiles,
            outputPath,
            context.App.TargetKind,
            context.App.ReferencedAssemblies);

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
            artifacts.Add(context.Triage.CompileError(diagnostic, file));
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
