// <copyright file="IlVerifyStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Stage 3 (ADR-0115 §C): IL-verify the assembly emitted by a green stage-2
/// compile with the repo-pinned <c>dotnet-ilverify</c> (<see cref="IlVerifyRunner"/>).
/// Pass gate: <c>ilverify</c> reports no errors after the two documented
/// false-positive bundles are ignored (<see cref="IlVerifyRunner.KnownIlVerifyFalsePositives"/>).
/// On a real error the category is <c>ilverify-failure</c>, one triage artifact
/// per distinct error code + failing-method skeleton, and the app
/// short-circuits. Runs only after stage 2 publishes the emitted assembly path;
/// honors the <c>GSHARP_SKIP_ILVERIFY=1</c> bypass (then no-ops to PASS).
/// </summary>
public sealed class IlVerifyStage : IMigrationStage
{
    private readonly IlVerifyRunner runner;

    /// <summary>
    /// Initializes a new instance of the <see cref="IlVerifyStage"/> class.
    /// </summary>
    /// <param name="runner">
    /// The ilverify runner; when <see langword="null"/> a default runner that
    /// discovers the repo root is used.
    /// </param>
    public IlVerifyStage(IlVerifyRunner runner = null)
    {
        this.runner = runner ?? new IlVerifyRunner();
    }

    /// <inheritdoc/>
    public MigrationStageKind Kind => MigrationStageKind.IlVerify;

    /// <inheritdoc/>
    public Task<StageOutcome> ExecuteAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken = default)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        // No assembly was emitted (e.g. an empty translation that still passed
        // stage 2). Nothing to verify.
        if (string.IsNullOrEmpty(context.EmittedAssemblyPath))
        {
            return Task.FromResult(StageOutcome.Passed());
        }

        IlVerifyResult result = this.runner.Verify(
            context.EmittedAssemblyPath,
            context.App.ReferencedAssemblies);

        File.WriteAllText(
            Path.Combine(context.AppRunDir, "ilverify.log"),
            result.Output ?? string.Empty);

        if (result.Succeeded)
        {
            return Task.FromResult(StageOutcome.Passed());
        }

        string gsFile = context.EmittedFiles.Count > 0 ? context.EmittedFiles[0].RelativeGsPath : null;

        var artifacts = new List<TriageArtifact>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (IlVerifyError error in result.Errors)
        {
            // One artifact per distinct error-code + failing-method skeleton.
            string key = (error.Code ?? string.Empty) + "|" + (error.Method ?? string.Empty);
            if (!seen.Add(key))
            {
                continue;
            }

            artifacts.Add(context.Triage.IlVerifyFailure(error, gsFile));
        }

        // Non-zero exit with no parseable error line (e.g. a tool crash): capture
        // a synthetic ilverify-failure so the gate failure is not lost.
        if (artifacts.Count == 0)
        {
            string message = "ilverify exited with code " + result.ExitCode +
                " and no parseable error. Output: " + Truncate(result.Output);
            var synthetic = new IlVerifyError("IlVerifyError", null, message);
            artifacts.Add(context.Triage.IlVerifyFailure(synthetic, gsFile));
        }

        return Task.FromResult(StageOutcome.Failed(artifacts));
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
