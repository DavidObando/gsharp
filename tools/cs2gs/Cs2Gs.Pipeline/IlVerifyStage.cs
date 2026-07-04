// <copyright file="IlVerifyStage.cs" company="GSharp">
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
/// Stage 3 (ADR-0115 §C): IL-verify the assembly emitted by a green stage-2
/// compile with the repo-pinned <c>dotnet-ilverify</c> (<see cref="IlVerifyRunner"/>).
/// Pass gate: <c>ilverify</c> reports no errors after the two documented
/// false-positive bundles are ignored (<see cref="IlVerifyRunner.KnownIlVerifyFalsePositives"/>).
/// Apps with <see cref="CorpusApp.AllowUnsafeIl"/> set (issue #1933) get one
/// more allowance: unsafe C# (pointer writes, <c>fixed</c>, <c>stackalloc</c>)
/// lowers to IL that is unverifiable BY DESIGN — not a gsc defect, the
/// csc-compiled baseline of the same C# fails ilverify identically — so a
/// failure with at least one parsed error is treated as expected and does not
/// gate. A tool crash (non-zero exit, zero parsed errors) still gates for
/// those apps too: that signals a broken verifier run, not unsafe IL.
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

        // Unsafe-IL allowance (#1933): the app opted into
        // CorpusApp.AllowUnsafeIl and ilverify actually parsed error(s) (as
        // opposed to a bare tool crash) — expected-unverifiable, not a gate.
        // When the marker scopes to specific fixture types (#1985), only
        // errors whose failing method belongs to one of those types are
        // swallowed; an error elsewhere in the app still gates, so a genuine
        // unsafe-IL regression outside the allow-listed fixture(s) is not
        // masked by the app-wide marker.
        IReadOnlyList<IlVerifyError> gatingErrors = result.Errors;
        if (context.App.AllowUnsafeIl && result.Errors.Count > 0)
        {
            if (context.App.AllowUnsafeIlTypes.Count == 0)
            {
                return Task.FromResult(StageOutcome.Passed());
            }

            gatingErrors = result.Errors.Where(e => !IsAllowedUnsafeType(e, context.App.AllowUnsafeIlTypes)).ToList();
            if (gatingErrors.Count == 0)
            {
                return Task.FromResult(StageOutcome.Passed());
            }
        }

        string gsFile = context.EmittedFiles.Count > 0 ? context.EmittedFiles[0].RelativeGsPath : null;

        var artifacts = new List<TriageArtifact>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (IlVerifyError error in gatingErrors)
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

    // `error.Method` is the `Type::Method(sig)` skeleton (IlVerifyRunner); the
    // allow-listed marker lines are bare type names, so match on the
    // `Type::` prefix.
    private static bool IsAllowedUnsafeType(IlVerifyError error, IReadOnlyList<string> allowedTypes)
    {
        if (string.IsNullOrEmpty(error.Method))
        {
            return false;
        }

        foreach (string allowedType in allowedTypes)
        {
            if (error.Method.StartsWith(allowedType + "::", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
