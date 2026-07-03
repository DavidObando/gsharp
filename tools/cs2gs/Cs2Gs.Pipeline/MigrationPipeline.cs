// <copyright file="MigrationPipeline.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The spine of the C#→G# migration tool (ADR-0115 §C): it runs an ordered
/// <see cref="IReadOnlyList{IMigrationStage}"/> per corpus app, short-circuiting
/// on the first failure, and writes the per-failure triage artifacts (§D) plus
/// the machine-readable run summary (§F) under the run directory. Stages 3
/// (<c>ilverify</c>) and 4 (<c>test-parity</c>) slot in by appending two more
/// <see cref="IMigrationStage"/> implementations to <see cref="Stages"/>.
/// </summary>
public sealed class MigrationPipeline
{
    private readonly PipelineOptions options;

    /// <summary>
    /// Initializes a new instance of the <see cref="MigrationPipeline"/> class.
    /// </summary>
    /// <param name="options">The whole-run options.</param>
    /// <param name="stages">
    /// The ordered stages to execute; when <see langword="null"/> the default
    /// stages 1–2 (<see cref="TranslateStage"/>, <see cref="CompileStage"/>) are
    /// used.
    /// </param>
    public MigrationPipeline(PipelineOptions options, IReadOnlyList<IMigrationStage> stages = null)
    {
        this.options = options ?? throw new ArgumentNullException(nameof(options));
        this.Stages = stages ?? DefaultStages();
    }

    /// <summary>Gets the ordered stages this pipeline executes.</summary>
    public IReadOnlyList<IMigrationStage> Stages { get; }

    /// <summary>
    /// Gets the default ordered stage list (stages 1–4:
    /// <see cref="TranslateStage"/> → <see cref="CompileStage"/> →
    /// <see cref="IlVerifyStage"/> → <see cref="TestParityStage"/>).
    /// </summary>
    /// <returns>The default ordered stages.</returns>
    public static IReadOnlyList<IMigrationStage> DefaultStages() => new IMigrationStage[]
    {
        new TranslateStage(),
        new CompileStage(),
        new IlVerifyStage(),
        new TestParityStage(),
    };

    /// <summary>
    /// Sanitizes a corpus app id into a filesystem-safe directory segment
    /// (<c>corpus/L1-Console</c> → <c>corpus_L1-Console</c>).
    /// </summary>
    /// <param name="id">The corpus app id.</param>
    /// <returns>The sanitized segment.</returns>
    public static string SanitizeAppId(string id) => id.Replace('/', '_').Replace('\\', '_');

    /// <summary>
    /// Executes the pipeline over the supplied apps, writing all artifacts and
    /// the run summary, and returns the machine-readable run result.
    /// </summary>
    /// <param name="apps">The corpus apps to migrate, in order.</param>
    /// <param name="cancellationToken">A cancellation token.</param>
    /// <returns>The whole-run result.</returns>
    /// <exception cref="InvalidOperationException">No <c>gsc.dll</c> could be resolved.</exception>
    public async Task<RunResult> RunAsync(
        IReadOnlyList<CorpusApp> apps,
        CancellationToken cancellationToken = default)
    {
        if (apps is null)
        {
            throw new ArgumentNullException(nameof(apps));
        }

        string gscPath = GscInvoker.Resolve(
            this.options.GscPath,
            this.options.Config,
            Directory.GetCurrentDirectory());
        if (gscPath is null)
        {
            throw new InvalidOperationException(
                "Could not resolve gsc.dll. Build GSharp.sln or pass --gsc <path>.");
        }

        var gsc = new GscInvoker(gscPath);
        string gscVersion = gsc.GetVersion();

        DateTime nowUtc = DateTime.UtcNow;
        string runId = NewRunId(nowUtc);
        string timestamp = nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

        string outputRoot = Path.GetFullPath(
            this.options.OutputRoot ?? Path.Combine(Directory.GetCurrentDirectory(), "cs2gs-runs"));
        string runDir = Path.Combine(outputRoot, runId);
        Directory.CreateDirectory(runDir);

        IReadOnlyDictionary<string, List<TriageRetryEntry>> priorHistory =
            LoadPriorRetryEntries(outputRoot, runId);

        var runResult = new RunResult
        {
            RunId = runId,
            Timestamp = timestamp,
            GscVersion = gscVersion,
            GscPath = gscPath,
            Succeeded = true,
        };

        foreach (CorpusApp app in apps)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AppResult appResult = await this.RunAppAsync(
                app, gsc, gscVersion, runId, timestamp, runDir, priorHistory, cancellationToken)
                .ConfigureAwait(false);
            runResult.Apps.Add(appResult);
            if (!appResult.Succeeded)
            {
                runResult.Succeeded = false;
            }
        }

        string runJsonPath = Path.Combine(runDir, "run.json");
        File.WriteAllText(runJsonPath, JsonSerializer.Serialize(runResult, TriageSerialization.Options));

        return runResult;
    }

    private static string NewRunId(DateTime utc)
    {
        string stamp = utc.ToString("yyyy-MM-ddTHH-mm-ssZ", CultureInfo.InvariantCulture);
        byte[] random = RandomNumberGenerator.GetBytes(3);
        return stamp + "_" + Convert.ToHexString(random).ToLowerInvariant();
    }

    private static string FingerprintShort(string fingerprint)
    {
        string hex = fingerprint.StartsWith("sha256:", StringComparison.Ordinal)
            ? fingerprint.Substring("sha256:".Length)
            : fingerprint;
        return hex.Length <= 12 ? hex : hex.Substring(0, 12);
    }

    private static IReadOnlyDictionary<string, List<TriageRetryEntry>> LoadPriorRetryEntries(
        string outputRoot,
        string currentRunId)
    {
        var map = new Dictionary<string, List<TriageRetryEntry>>(StringComparer.Ordinal);
        if (!Directory.Exists(outputRoot))
        {
            return map;
        }

        foreach (string priorRunDir in Directory.EnumerateDirectories(outputRoot)
            .Where(d => !string.Equals(new DirectoryInfo(d).Name, currentRunId, StringComparison.Ordinal))
            .OrderBy(d => new DirectoryInfo(d).Name, StringComparer.Ordinal))
        {
            // Retry-entry artifacts are written by WriteArtifacts() (below) at
            // exactly one location: <runDir>/<sanitizedAppId>/<stage>-<hash>.json
            // (top-level files directly under each app's run directory; see
            // WriteArtifacts). A recursive "*.json" scan of priorRunDir also
            // walks into stage-4 (test-parity) scaffolds such as
            // <appDir>/test-parity/<Lib>/obj/, whose NuGet-restore JSON
            // (project.assets.json, *.nuget.*.json, MSBuild caches) can be
            // several MB each and grows with every prior run — making this
            // loop cost quadratic over the lifetime of an output root
            // (issue #1751). Enumerate only the app directories directly
            // under priorRunDir, and only the top-level files in each,
            // matching the writer's layout exactly instead of descending into
            // build artifacts.
            foreach (string appDir in Directory.EnumerateDirectories(priorRunDir))
            {
                foreach (string file in Directory.EnumerateFiles(appDir, "*.json", SearchOption.TopDirectoryOnly))
                {
                    TriageArtifact prior = TryReadArtifact(file);
                    if (prior?.Fingerprint is null)
                    {
                        continue;
                    }

                    if (!map.TryGetValue(prior.Fingerprint, out List<TriageRetryEntry> entries))
                    {
                        entries = new List<TriageRetryEntry>();
                        map[prior.Fingerprint] = entries;
                    }

                    if (entries.All(e => !string.Equals(e.RunId, prior.RunId, StringComparison.Ordinal)))
                    {
                        entries.Add(new TriageRetryEntry
                        {
                            RunId = prior.RunId,
                            GscVersion = prior.GscVersion,
                            Result = "fail",
                        });
                    }
                }
            }
        }

        return map;
    }

    private static TriageArtifact TryReadArtifact(string path)
    {
        try
        {
            return JsonSerializer.Deserialize<TriageArtifact>(File.ReadAllText(path), TriageSerialization.Options);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private async Task<AppResult> RunAppAsync(
        CorpusApp app,
        GscInvoker gsc,
        string gscVersion,
        string runId,
        string timestamp,
        string runDir,
        IReadOnlyDictionary<string, List<TriageRetryEntry>> priorHistory,
        CancellationToken cancellationToken)
    {
        string appRunDir = Path.Combine(runDir, SanitizeAppId(app.Id));
        Directory.CreateDirectory(appRunDir);

        var triage = new TriageBuilder(runId, timestamp, gscVersion, app.Id);
        var context = new StageExecutionContext(app, this.options, gsc, appRunDir, triage);

        var appResult = new AppResult { AppId = app.Id, Succeeded = true };
        bool shortCircuited = false;

        foreach (IMigrationStage stage in this.Stages)
        {
            string stageName = TriageSerialization.StageName(stage.Kind);
            if (shortCircuited)
            {
                appResult.Stages.Add(new StageResult
                {
                    Stage = stageName,
                    Status = "skipped",
                    ArtifactCount = 0,
                });
                continue;
            }

            StageOutcome outcome;
            try
            {
                outcome = await stage.ExecuteAsync(context, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                outcome = StageOutcome.Failed(new[] { StageCrashArtifact(triage, stage.Kind, ex) });
            }

            if (outcome.Status == StageStatus.Passed)
            {
                appResult.Stages.Add(new StageResult
                {
                    Stage = stageName,
                    Status = "passed",
                    ArtifactCount = 0,
                });
                continue;
            }

            if (outcome.Status == StageStatus.Skipped)
            {
                // "Not verified" (issue #1749): a genuinely-unavailable
                // dependency (no locally-built SDK, a translation step not
                // implemented yet) is neither a pass nor a failure. It must not
                // render as green, so it gets its own status rather than
                // StageStatus.Passed, but it also does not fail the app or
                // short-circuit later stages.
                appResult.Stages.Add(new StageResult
                {
                    Stage = stageName,
                    Status = "skipped",
                    ArtifactCount = 0,
                });
                continue;
            }

            IReadOnlyList<TriageArtifact> written = this.WriteArtifacts(
                outcome.Artifacts, appRunDir, runDir, priorHistory, appResult);

            appResult.Stages.Add(new StageResult
            {
                Stage = stageName,
                Status = "failed",
                ArtifactCount = written.Count,
            });
            appResult.Succeeded = false;
            appResult.FailureCategory = written.FirstOrDefault()?.Category;
            foreach (TriageArtifact artifact in written)
            {
                appResult.Fingerprints.Add(artifact.Fingerprint);
            }

            shortCircuited = true;
        }

        return appResult;
    }

    private TriageArtifact StageCrashArtifact(TriageBuilder triage, MigrationStageKind stage, Exception ex)
    {
        // A stage throwing (e.g. project load failure) is itself a captured
        // gap. Fingerprinted via TriageBuilder.StageCrash (issue #1750) on the
        // exception's runtime type rather than its raw Message, which
        // routinely embeds run-scoped absolute paths that would otherwise
        // fingerprint the same recurring crash differently every run/machine.
        (TriageCategory category, string diagnosticId) = stage switch
        {
            MigrationStageKind.Compile => (TriageCategory.CompileError, "GS9999"),
            MigrationStageKind.IlVerify => (TriageCategory.IlVerifyFailure, "IlVerifyError"),
            MigrationStageKind.TestParity => (TriageCategory.TestParityFailure, "STDOUT-MISMATCH"),
            _ => (TriageCategory.TranslationUnsupported, "PipelineException"),
        };

        return triage.StageCrash(stage, category, diagnosticId, ex);
    }

    private IReadOnlyList<TriageArtifact> WriteArtifacts(
        IReadOnlyList<TriageArtifact> artifacts,
        string appRunDir,
        string runDir,
        IReadOnlyDictionary<string, List<TriageRetryEntry>> priorHistory,
        AppResult appResult)
    {
        var written = new List<TriageArtifact>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (TriageArtifact artifact in artifacts)
        {
            // Dedup within an app: one file per distinct fingerprint.
            if (!seen.Add(artifact.Fingerprint))
            {
                continue;
            }

            if (priorHistory.TryGetValue(artifact.Fingerprint, out List<TriageRetryEntry> history))
            {
                artifact.RetryHistory.AddRange(history);
            }

            string fileName = artifact.Stage + "-" + FingerprintShort(artifact.Fingerprint) + ".json";
            string artifactPath = Path.Combine(appRunDir, fileName);
            File.WriteAllText(artifactPath, JsonSerializer.Serialize(artifact, TriageSerialization.Options));

            string relative = Path.GetRelativePath(runDir, artifactPath).Replace('\\', '/');
            appResult.Artifacts.Add(relative);
            written.Add(artifact);
        }

        return written;
    }
}
