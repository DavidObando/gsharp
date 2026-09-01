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
using Cs2Gs.Translator.Loading;

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
    /// The artifact directory name for one app under a run directory. In
    /// repository layout it is suffixed with a hash of the app id so two
    /// projects with the same sanitized id cannot collide. Deterministic from
    /// the app id alone, so a <c>validate</c> shard can locate the manifest
    /// written by the whole-repository translate pass (issue #3668).
    /// </summary>
    /// <param name="appId">The corpus app id.</param>
    /// <param name="layout">The migration output layout.</param>
    /// <returns>The artifact directory name.</returns>
    public static string ArtifactDirectoryName(string appId, MigrationOutputLayout layout) =>
        layout == MigrationOutputLayout.Repository
            ? SanitizeAppId(appId) + "-" + Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(appId))).Substring(0, 8).ToLowerInvariant()
            : SanitizeAppId(appId);

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

        // Issue #2215: best-effort — an app with no analyzer references never
        // touches this path (gsc's own /analyzer: fast path is a no-op), so a
        // missing gsgen.dll here is not fatal; it only matters for apps whose
        // project references generators.
        string gsgenPath = GscInvoker.ResolveGsgenTool(
            this.options.GsgenPath,
            this.options.Config,
            Directory.GetCurrentDirectory());

        var gsc = new GscInvoker(gscPath, gsgenPath);
        string gscVersion = gsc.GetVersion();

        DateTime nowUtc = DateTime.UtcNow;
        string runId = NewRunId(nowUtc);
        string timestamp = nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

        bool repositoryLayout = this.options.OutputLayout == MigrationOutputLayout.Repository;
        if (repositoryLayout && string.IsNullOrWhiteSpace(this.options.OutputRoot))
        {
            throw new InvalidOperationException("Repository migration requires an output directory.");
        }

        string destinationRoot = repositoryLayout
            ? Path.GetFullPath(this.options.OutputRoot)
            : null;
        string outputRoot = repositoryLayout
            ? Path.GetFullPath(this.options.ArtifactRoot ?? destinationRoot + ".cs2gs-runs")
            : Path.GetFullPath(
                this.options.OutputRoot ?? Path.Combine(Directory.GetCurrentDirectory(), "cs2gs-runs"));
        if (repositoryLayout)
        {
            string relativeArtifactPath = Path.GetRelativePath(destinationRoot, outputRoot);
            if (!Path.IsPathRooted(relativeArtifactPath) &&
                !relativeArtifactPath.Equals("..", StringComparison.Ordinal) &&
                !relativeArtifactPath.StartsWith(
                    ".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
                !relativeArtifactPath.StartsWith(
                    ".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Repository validation artifacts must be outside the destination directory.");
            }
        }

        string runDir = Path.Combine(outputRoot, runId);
        IReadOnlyList<string> repositoryFiles = null;
        if (repositoryLayout)
        {
            repositoryFiles = RepositoryMirror.Prepare(this.options.SourceRoot, destinationRoot);
            this.options.RepositorySourceFiles = repositoryFiles
                .Where(path => Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase))
                .Select(path => Path.GetFullPath(Path.Combine(this.options.SourceRoot, path)))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            this.options.RepositoryTranslations =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            this.options.RepositoryAdditionalFiles =
                new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }

        Directory.CreateDirectory(runDir);

        // Issue #3645: an executable app that another app in this run compiles
        // against must keep its entry-point class as a real G# class (see
        // PipelineOptions.ProjectsReferencedByOtherApps).
        this.options.ProjectsReferencedByOtherApps =
            DeclaredProjectItems.CollectCompileReferencedProjectPaths(
                apps.Select(app => app.ProjectPath));

        this.options.GeneratedProjectPaths = apps.ToDictionary(
            app => Path.GetFullPath(app.ProjectPath),
            app => repositoryLayout
                ? Path.Combine(
                    destinationRoot,
                    Path.ChangeExtension(
                        app.RelativeProjectPath ?? Path.GetRelativePath(this.options.SourceRoot, app.ProjectPath),
                        ".gsproj"))
                : Path.Combine(
                    runDir,
                    SanitizeAppId(app.Id),
                    Path.GetFileNameWithoutExtension(app.ProjectPath) + ".gsproj"),
            StringComparer.OrdinalIgnoreCase);
        RepositoryExcludedScope excludedScope = repositoryLayout
            ? RepositoryExcludedScope.Compute(this.options.SourceRoot, this.options.ExcludedProjectPaths)
            : null;
        if (repositoryLayout)
        {
            string sdkMoniker = SdkCompileRunner.ResolveSdkMoniker(this.options.Config);
            if (sdkMoniker is null)
            {
                throw new InvalidOperationException(
                    "Could not resolve a local Gsharp.NET.Sdk package for the mirrored projects.");
            }

            foreach (CorpusApp app in apps)
            {
                string generatedProjectPath =
                    this.options.GeneratedProjectPaths[Path.GetFullPath(app.ProjectPath)];
                Directory.CreateDirectory(Path.GetDirectoryName(generatedProjectPath));
                System.Xml.Linq.XDocument transformed = GSharpProjectTransformer.Transform(
                    app.ProjectPath,
                    Path.GetDirectoryName(generatedProjectPath),
                    sdkMoniker,
                    this.options.GeneratedProjectPaths);
                transformed.Save(
                    generatedProjectPath,
                    System.Xml.Linq.SaveOptions.DisableFormatting);
            }

            // Issue #3772: an excluded project with nothing to translate still
            // belongs in the mirror — dropping only its project file leaves a
            // half project its consumers cannot reference.
            foreach (string mirroredProject in RepositoryMirror.MirrorExcludedProjects(
                this.options.SourceRoot,
                destinationRoot,
                repositoryFiles,
                excludedScope,
                this.options.GeneratedProjectPaths))
            {
                this.options.RepositoryAdditionalFiles.Add(mirroredProject);
            }

            var loadedProjects = new Dictionary<string, LoadedCSharpProject>(StringComparer.OrdinalIgnoreCase);
            foreach (CorpusApp app in apps)
            {
                string projectPath = Path.GetFullPath(app.ProjectPath);
                loadedProjects[projectPath] = await CSharpProjectLoader.LoadProjectAsync(
                    projectPath,
                    cancellationToken,
                    includeAutoGenerated: true,
                    includedAutoGeneratedPaths: this.options.RepositorySourceFiles).ConfigureAwait(false);
            }

            this.options.RepositoryLoadedProjects = loadedProjects;
        }

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

        var appResults = new Dictionary<string, AppResult>(StringComparer.OrdinalIgnoreCase);
        IReadOnlyList<CorpusApp> orderedApps = repositoryLayout
            ? await this.OrderForSdkBuildAsync(apps, cancellationToken).ConfigureAwait(false)
            : this.OrderForSdkBuild(apps);
        foreach (CorpusApp app in orderedApps)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AppResult appResult = await this.RunAppAsync(
                app, gsc, gscVersion, runId, timestamp, runDir, priorHistory, cancellationToken)
                .ConfigureAwait(false);
            appResults[app.Id] = appResult;
            if (!appResult.Succeeded)
            {
                runResult.Succeeded = false;
            }
        }

        foreach (CorpusApp app in apps)
        {
            runResult.Apps.Add(appResults[app.Id]);
        }

        if (repositoryLayout)
        {
            if (runResult.Succeeded)
            {
                // Issue #3580: an orphan-mirror failure marks the run failed
                // (the nightly gate must still catch a checked-in C# file with
                // no translatable mirror) but no longer throws — the report
                // table and run.json land either way.
                IReadOnlyList<string> orphanFailures = RepositoryOrphanSourceTranslator.TranslateMissing(
                    this.options.SourceRoot,
                    destinationRoot,
                    repositoryFiles,
                    excludedScope);
                if (orphanFailures.Count > 0)
                {
                    runResult.Succeeded = false;
                    foreach (string failure in orphanFailures)
                    {
                        Console.Error.WriteLine("cs2gs: " + failure);
                    }
                }
            }

            RepositorySolutionGenerator.Generate(
                this.options.SourceRoot,
                destinationRoot,
                this.options.GeneratedProjectPaths,
                repositoryFiles);
            if (runResult.Succeeded)
            {
                try
                {
                    RepositoryMirror.ValidateCompleted(
                        this.options.SourceRoot,
                        destinationRoot,
                        repositoryFiles,
                        this.options.RepositoryAdditionalFiles,
                        excludedScope);
                }
                catch (InvalidOperationException ex)
                {
                    // Issue #3580: same recorded-not-thrown contract as the
                    // orphan step — completeness failures gate the run but
                    // must not eat the report.
                    runResult.Succeeded = false;
                    Console.Error.WriteLine("cs2gs: " + ex.Message);
                }
            }
        }
        else
        {
            SolutionGenerator.Generate(
                this.options.SourceRoot,
                runDir,
                this.options.GeneratedProjectPaths);
        }

        if (runResult.Succeeded && runResult.Apps.Any(a => a.Unverified))
        {
            runResult.Unverified = true;
        }

        string runJsonPath = Path.Combine(runDir, "run.json");
        File.WriteAllText(runJsonPath, JsonSerializer.Serialize(runResult, TriageSerialization.Options));

        return runResult;
    }

    /// <summary>
    /// Validates an ALREADY-migrated repository tree for a subset of its apps
    /// (issue #3668). Runs this pipeline's stages — normally compile →
    /// ilverify → test-parity — against the migrated tree at
    /// <see cref="PipelineOptions.OutputRoot"/>, rehydrating each app's
    /// translate-derived state from the <see cref="ValidationManifest"/> the
    /// whole-repository <c>migrate</c> pass wrote, and returns a PARTIAL
    /// <see cref="RunResult"/> covering only <paramref name="selectedApps"/>.
    /// <para>
    /// <paramref name="allApps"/> must be the COMPLETE app list of the migrate
    /// run (same <c>--exclude</c> set), because the mirrored project map every
    /// stage resolves <c>ProjectReference</c>s through is repository-wide.
    /// Narrowing it — for instance by excluding the projects a shard does not
    /// own — breaks reference resolution and manufactures phantom cascades.
    /// </para>
    /// </summary>
    /// <param name="allApps">Every app in the migrated tree, in discovery order.</param>
    /// <param name="selectedApps">The subset this shard validates.</param>
    /// <param name="manifestRunDir">The migrate run directory holding the per-app manifests.</param>
    /// <param name="cancellationToken">A cancellation token.</param>
    /// <returns>The partial run result for <paramref name="selectedApps"/>.</returns>
    /// <exception cref="InvalidOperationException">No <c>gsc.dll</c> could be resolved.</exception>
    public async Task<RunResult> ValidateAsync(
        IReadOnlyList<CorpusApp> allApps,
        IReadOnlyList<CorpusApp> selectedApps,
        string manifestRunDir,
        CancellationToken cancellationToken = default)
    {
        if (allApps is null)
        {
            throw new ArgumentNullException(nameof(allApps));
        }

        if (selectedApps is null)
        {
            throw new ArgumentNullException(nameof(selectedApps));
        }

        if (string.IsNullOrWhiteSpace(this.options.OutputRoot))
        {
            throw new InvalidOperationException("Validation requires --migrated <existing-migrated-tree>.");
        }

        string migratedRoot = Path.GetFullPath(this.options.OutputRoot);
        if (!Directory.Exists(migratedRoot))
        {
            throw new InvalidOperationException($"Migrated tree '{migratedRoot}' does not exist.");
        }

        this.options.OutputLayout = MigrationOutputLayout.Repository;

        string gscPath = GscInvoker.Resolve(
            this.options.GscPath,
            this.options.Config,
            Directory.GetCurrentDirectory());
        if (gscPath is null)
        {
            throw new InvalidOperationException(
                "Could not resolve gsc.dll. Build GSharp.sln or pass --gsc <path>.");
        }

        string gsgenPath = GscInvoker.ResolveGsgenTool(
            this.options.GsgenPath,
            this.options.Config,
            Directory.GetCurrentDirectory());
        var gsc = new GscInvoker(gscPath, gsgenPath);
        string gscVersion = gsc.GetVersion();

        DateTime nowUtc = DateTime.UtcNow;
        string runId = NewRunId(nowUtc);
        string timestamp = nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

        string outputRoot = Path.GetFullPath(
            this.options.ArtifactRoot ?? migratedRoot + ".cs2gs-runs");
        string runDir = Path.Combine(outputRoot, runId);
        Directory.CreateDirectory(runDir);

        // The mirrored-project map is repository-wide by construction: it is
        // the same map the migrate pass built, computed from the full app list
        // and the migrated tree root.
        this.options.GeneratedProjectPaths = allApps.ToDictionary(
            app => Path.GetFullPath(app.ProjectPath),
            app => Path.Combine(
                migratedRoot,
                Path.ChangeExtension(
                    app.RelativeProjectPath ?? Path.GetRelativePath(this.options.SourceRoot, app.ProjectPath),
                    ".gsproj")),
            StringComparer.OrdinalIgnoreCase);
        this.options.ProjectsReferencedByOtherApps =
            DeclaredProjectItems.CollectCompileReferencedProjectPaths(
                allApps.Select(app => app.ProjectPath));

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

        foreach (CorpusApp app in selectedApps)
        {
            cancellationToken.ThrowIfCancellationRequested();

            StageExecutionContext context = this.CreateAppContext(
                app, gsc, gscVersion, runId, timestamp, runDir, out string artifactDir);

            ValidationManifest manifest = ValidationManifest.Read(
                Path.Combine(
                    manifestRunDir ?? string.Empty,
                    ArtifactDirectoryName(app.Id, MigrationOutputLayout.Repository)));
            if (manifest is null)
            {
                throw new InvalidOperationException(
                    $"No {ValidationManifest.FileName} for app '{app.Id}' under '{manifestRunDir}'. " +
                    "Validation shards must run against the artifacts of the migrate pass that " +
                    "produced the migrated tree.");
            }

            if (!manifest.Translated)
            {
                // The app never got past stage 1, so it has no migrated sources
                // to compile and its verdict already exists in the migrate run.
                // Reporting it here would render an empty compile as a PASS and
                // inflate the green count; the merge takes the translate
                // failure from the migrate pass instead.
                Console.WriteLine($"cs2gs validate: skipping '{app.Id}' — it did not translate.");
                continue;
            }

            manifest.Hydrate(context, migratedRoot);

            AppResult appResult = await this.RunStagesAsync(
                app, context, artifactDir, runDir, priorHistory, cancellationToken).ConfigureAwait(false);
            runResult.Apps.Add(appResult);
            if (!appResult.Succeeded)
            {
                runResult.Succeeded = false;
            }
        }

        if (runResult.Succeeded && runResult.Apps.Any(a => a.Unverified))
        {
            runResult.Unverified = true;
        }

        File.WriteAllText(
            Path.Combine(runDir, "run.json"),
            JsonSerializer.Serialize(runResult, TriageSerialization.Options));

        return runResult;
    }

    private IReadOnlyList<CorpusApp> OrderForSdkBuild(IReadOnlyList<CorpusApp> apps)
    {
        if (!this.options.CompileViaSdk || apps.Count <= 1)
        {
            return apps;
        }

        var byPath = apps.ToDictionary(
            app => Path.GetFullPath(app.ProjectPath),
            StringComparer.OrdinalIgnoreCase);
        var ordered = new List<CorpusApp>(apps.Count);
        var visiting = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Visit(CorpusApp app)
        {
            string path = Path.GetFullPath(app.ProjectPath);
            if (!visited.Add(path))
            {
                return;
            }

            if (!visiting.Add(path))
            {
                return;
            }

            foreach (string referencePath in DeclaredProjectItems.ProjectReferencePaths(path))
            {
                if (byPath.TryGetValue(referencePath, out CorpusApp dependency))
                {
                    Visit(dependency);
                }
            }

            visiting.Remove(path);
            ordered.Add(app);
        }

        foreach (CorpusApp app in apps)
        {
            Visit(app);
        }

        return ordered;
    }

    private async Task<IReadOnlyList<CorpusApp>> OrderForSdkBuildAsync(
        IReadOnlyList<CorpusApp> apps,
        CancellationToken cancellationToken)
    {
        if (!this.options.CompileViaSdk || apps.Count <= 1)
        {
            return apps;
        }

        var byPath = apps.ToDictionary(
            app => Path.GetFullPath(app.ProjectPath),
            StringComparer.OrdinalIgnoreCase);
        var references = new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (CorpusApp app in apps)
        {
            IReadOnlyList<Cs2Gs.Translator.Loading.LoadedCSharpProject> loaded =
                await Cs2Gs.Translator.Loading.CSharpProjectLoader
                    .LoadProjectWithReferencesAsync(app.ProjectPath, cancellationToken)
                    .ConfigureAwait(false);

            // Issue #3617: the Roslyn loader follows compile references only,
            // so an analyzer-shaped reference (`OutputItemType="Analyzer"
            // ReferenceOutputAssembly="false"`, e.g. Core → InternalAnalyzers)
            // never becomes an ordering edge. Union in the XML-declared
            // ProjectReference paths so a dependent app cannot build before
            // its analyzer dependency has translated its sources — building
            // the dependency from a source-less mirror directory produces a
            // two-file husk assembly that later fails analyzer discovery
            // (GS9301).
            references[Path.GetFullPath(app.ProjectPath)] = loaded
                .Skip(1)
                .Select(project => project.ProjectPath)
                .Where(path => !string.IsNullOrEmpty(path))
                .Select(Path.GetFullPath)
                .Concat(DeclaredProjectItems.ProjectReferencePaths(app.ProjectPath))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        var ordered = new List<CorpusApp>(apps.Count);
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Visit(CorpusApp app)
        {
            string path = Path.GetFullPath(app.ProjectPath);
            if (!visited.Add(path))
            {
                return;
            }

            foreach (string reference in references[path])
            {
                if (byPath.TryGetValue(reference, out CorpusApp dependency))
                {
                    Visit(dependency);
                }
            }

            ordered.Add(app);
        }

        foreach (CorpusApp app in apps)
        {
            Visit(app);
        }

        return ordered;
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

    private StageExecutionContext CreateAppContext(
        CorpusApp app,
        GscInvoker gsc,
        string gscVersion,
        string runId,
        string timestamp,
        string runDir,
        out string artifactDir)
    {
        artifactDir = Path.Combine(runDir, ArtifactDirectoryName(app.Id, this.options.OutputLayout));
        string projectOutputDir = this.options.OutputLayout == MigrationOutputLayout.Repository
            ? Path.GetDirectoryName(this.options.GeneratedProjectPaths[Path.GetFullPath(app.ProjectPath)])
            : artifactDir;
        Directory.CreateDirectory(artifactDir);
        Directory.CreateDirectory(projectOutputDir);

        var triage = new TriageBuilder(runId, timestamp, gscVersion, app.Id);
        return new StageExecutionContext(
            app, this.options, gsc, projectOutputDir, artifactDir, triage);
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
        StageExecutionContext context = this.CreateAppContext(
            app, gsc, gscVersion, runId, timestamp, runDir, out string artifactDir);

        AppResult appResult = await this.RunStagesAsync(
            app, context, artifactDir, runDir, priorHistory, cancellationToken).ConfigureAwait(false);

        if (this.options.OutputLayout == MigrationOutputLayout.Repository &&
            !string.IsNullOrWhiteSpace(this.options.OutputRoot))
        {
            // Issue #3668: hand the translate-derived state of this app to any
            // later `cs2gs validate` shard over the same migrated tree.
            bool translated = appResult.Stages
                .Any(s => s.Stage == TriageSerialization.StageName(MigrationStageKind.Translate)
                    && s.Status == "passed");
            ValidationManifest.Write(
                ValidationManifest.Capture(context, translated, this.options.OutputRoot),
                artifactDir);
        }

        return appResult;
    }

    private async Task<AppResult> RunStagesAsync(
        CorpusApp app,
        StageExecutionContext context,
        string artifactDir,
        string runDir,
        IReadOnlyDictionary<string, List<TriageRetryEntry>> priorHistory,
        CancellationToken cancellationToken)
    {
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
                outcome = StageOutcome.Failed(new[] { StageCrashArtifact(context.Triage, stage.Kind, ex) });
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
                outcome.Artifacts, artifactDir, runDir, priorHistory, appResult);

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

        if (appResult.Succeeded && appResult.Stages.Any(s => s.Status == "skipped"))
        {
            // No stage failed, but at least one was genuinely unverified
            // (issue #1831): don't let that roll up as green.
            appResult.Unverified = true;
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
