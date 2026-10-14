// <copyright file="IlVerifyStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks

/// Stage 3 (ADR-0115 §C): IL-verify the assembly emitted by a green stage-2
/// compile with the repo-pinned `dotnet-ilverify` ((cref:IlVerifyRunner)).
/// Pass gate: `ilverify` reports no errors after the two documented
/// false-positive bundles are ignored ((cref:IlVerifyRunner.KnownIlVerifyFalsePositives))
/// and the offset-exact filter-in-finally rule (#4489) is applied
/// ((cref:IlVerifyRunner.FilterKnownFalsePositives)).
/// Apps with (cref:CorpusApp.AllowUnsafeIl) set (issue #1933) get one
/// more allowance: unsafe C# (pointer writes, `fixed`, `stackalloc`)
/// lowers to IL that is unverifiable BY DESIGN — not a gsc defect, the
/// csc-compiled baseline of the same C# fails ilverify identically — so a
/// complete verifier failure with at least one parsed error is treated as
/// expected and does not gate. An incomplete run still gates for those apps
/// too: that signals a broken verifier run, not unsafe IL.
/// On a real error the category is `ilverify-failure`, one triage artifact
/// per distinct error code + failing-method skeleton; incomplete runs also get
/// a distinct `IlVerifyIncomplete` artifact. The app then short-circuits.
/// Runs only after stage 2 publishes the emitted assembly path; honors the
/// `GSHARP_SKIP_ILVERIFY=1` bypass (then no-ops to PASS).
class IlVerifyStage : IMigrationStage {
    private let runner IlVerifyRunner

    /// Initializes a new instance of the (cref:IlVerifyStage) class.
    /// @param runner The ilverify runner; when `null` a default runner that
    /// discovers the repo root is used.
    init(runner IlVerifyRunner? = nil) {
        this.runner = runner ?? IlVerifyRunner()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Kind MigrationStageKind -> MigrationStageKind.IlVerify

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
        // No assembly was emitted (e.g. an empty translation that still passed
        // stage 2). Nothing to verify.
        if string.IsNullOrEmpty(context.EmittedAssemblyPath) {
            return Task.FromResult(StageOutcome.Passed())
        }
        var verifyReferences IReadOnlyList[string] = if context.App.ReferencedAssemblies is {Count: > 0} appRefs {
            appRefs.Concat(context.ExternalReferencePaths).ToList()
        } else {
            context.ExternalReferencePaths
        }
        // Issue #3608: a transformed analyzer project references the G#
        // analyzer API assembly from the compiler host's own directory with
        // Private=false, so it is in neither the build output nor the C#
        // project's reference closure — resolve those compiler-hosted
        // references here or ilverify fails with FileLoadErrorGeneric on
        // e.g. 'GSharp.Core'.
        let hostedReferences = ResolveCompilerHostedReferences(context)
        if hostedReferences.Count > 0 {
            verifyReferences = verifyReferences.Concat(hostedReferences).ToList()
        }
        let result = this.runner.Verify(context.EmittedAssemblyPath, verifyReferences)
        File.WriteAllText(Path.Combine(context.ArtifactDir, "ilverify.log"), result.Output ?? string.Empty)
        if result.Succeeded {
            return Task.FromResult(StageOutcome.Passed())
        }
        // Unsafe-IL allowance (#1933): the app opted into
        // CorpusApp.AllowUnsafeIl and ilverify actually parsed error(s) (as
        // opposed to a bare tool crash) — expected-unverifiable, not a gate.
        // When the marker scopes to specific fixture types (#1985), only
        // errors whose failing method belongs to one of those types are
        // swallowed; an error elsewhere in the app still gates, so a genuine
        // unsafe-IL regression outside the allow-listed fixture(s) is not
        // masked by the app-wide marker.
        var gatingErrors = result.Errors
        if result.Status == IlVerifyStatus.Failed && context.App.AllowUnsafeIl && result.Errors.Count > 0 {
            if context.App.AllowUnsafeIlTypes.Count == 0 {
                return Task.FromResult(StageOutcome.Passed())
            }
            gatingErrors = result
                .Errors
                .Where((e IlVerifyError) -> !IsAllowedUnsafeType(e, context.App.AllowUnsafeIlTypes))
                .ToList()
            if gatingErrors.Count == 0 {
                return Task.FromResult(StageOutcome.Passed())
            }
        }
        let gsFile string? = if context.EmittedFiles.Count > 0 {
            context.EmittedFiles[0].RelativeGsPath
        } else {
            default(string?)
        }
        let artifacts = List[TriageArtifact]()
        let seen = HashSet[string](StringComparer.Ordinal)
        for error in gatingErrors {
            // One artifact per distinct error-code + failing-method skeleton.
            let key = (error.Code ?? string.Empty) + "|" + (error.Method ?? string.Empty)
            if !seen.Add(key) {
                continue
            }
            artifacts.Add(context.Triage.IlVerifyFailure(error, gsFile))
        }
        // A crash is not an ordinary verifier finding. Always add a distinct
        // incompleteness artifact, alongside any findings recovered by retries.
        if result.Status == IlVerifyStatus.Incomplete {
            let excluded = if result.IncompleteMembers.Count == 0 {
                "none identified"
            } else {
                string.Join(", ", result.IncompleteMembers)
            }
            let message = "Verification incomplete: ilverify exited abnormally with code " +
                result
                .ExitCode
                .ToString() +
                ". Excluded crashing members: " +
                excluded +
                ". Findings from non-crashing members are reported separately. Output: " +
                Truncate(result.Output)
            let synthetic = IlVerifyError("IlVerifyIncomplete", nil, message)
            artifacts.Add(context.Triage.IlVerifyFailure(synthetic, gsFile))
        } else if artifacts.Count == 0 {
            let message = "ilverify exited with code " + result.ExitCode.ToString() +
                " without a parseable verifier finding. Output: " +
                Truncate(result.Output)
            artifacts.Add(context.Triage.IlVerifyFailure(IlVerifyError("IlVerifyError", nil, message), gsFile))
        }
        return Task.FromResult(StageOutcome.Failed(artifacts))
    }

    shared {
        // The transformed project is written into the migrated project directory
        // by both layouts (MigrationPipeline for the repository mirror,
        // SdkCompileRunner for diagnostic runs); there is exactly one .gsproj.
        private func ResolveCompilerHostedReferences(context StageExecutionContext) IReadOnlyList[string] {
            if string.IsNullOrEmpty(context.ProjectOutputDir) || !Directory.Exists(context.ProjectOutputDir) {
                return Array.Empty[string]()
            }
            let resolved = List[string]()
            for projectPath in Directory.EnumerateFiles(
                context.ProjectOutputDir,
                "*.gsproj",
                SearchOption.TopDirectoryOnly
            ) {
                resolved.AddRange(
                    GSharpProjectTransformer.ResolveCompilerHostedReferences(projectPath, context.Gsc.GscPath)
                )
            }
            return resolved
        }

        private func Truncate(value string) string {
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

        // `error.Method` is the `Type::Method(sig)` skeleton (IlVerifyRunner); the
        // allow-listed marker lines are bare type names, so match on the
        // `Type::` prefix.
        private func IsAllowedUnsafeType(error IlVerifyError, allowedTypes IReadOnlyList[string]) bool {
            if string.IsNullOrEmpty(error.Method) {
                return false
            }
            for allowedType in allowedTypes {
                if error.Method!!.StartsWith(allowedType + "::", StringComparison.Ordinal) {
                    return true
                }
            }
            return false
        }
    }
}
