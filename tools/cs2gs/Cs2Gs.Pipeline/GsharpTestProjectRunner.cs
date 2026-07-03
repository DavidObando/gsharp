// <copyright file="GsharpTestProjectRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The status of a <see cref="GsharpTestProjectRunner.Run"/> invocation.
/// </summary>
public enum GsharpTestRunStatus
{
    /// <summary>No locally-built SDK was found, so the run was not attempted.</summary>
    Unavailable,

    /// <summary>The project failed to build or run; no TRX was produced.</summary>
    BuildFailed,

    /// <summary><c>dotnet test</c> ran and produced a parseable TRX.</summary>
    Ran,
}

/// <summary>
/// The live library xUnit parity orchestration for stage 4 (ADR-0115 §C/§E):
/// given a translated G# library and its translated G# xUnit tests, this writes
/// an isolated G# test project that consumes the <b>locally-built</b>
/// <c>Gsharp.NET.Sdk</c> (copied into the repo's <c>.nugs</c> feed and pinned in
/// the generated <c>.gsproj</c>), runs <c>dotnet test</c> producing a TRX, and
/// parses it into the <c>{name, outcome}</c> set the comparison engine consumes.
/// All process I/O is local — it only shells out to <c>dotnet test</c>; there is
/// no network egress beyond NuGet restore and no keys. An isolation
/// <c>Directory.Build.props</c>/<c>.targets</c> pair is written at the work-dir
/// root so the repo-shared build (Nerdbank.GitVersioning, StyleCop) does not
/// apply to the generated G# project.
/// </summary>
public class GsharpTestProjectRunner
{
    private const string SdkPackageId = "Gsharp.NET.Sdk";
    private const string SdkPackagePrefix = SdkPackageId + ".";

    /// <summary>
    /// Initializes a new instance of the <see cref="GsharpTestProjectRunner"/> class.
    /// </summary>
    /// <param name="repoRoot">
    /// The repository root (the directory containing <c>nuget.config</c> and the
    /// <c>.nugs</c> feed). When <see langword="null"/> it is discovered by
    /// walking up from this assembly's location.
    /// </param>
    public GsharpTestProjectRunner(string repoRoot = null)
    {
        this.RepoRoot = repoRoot ?? FindRepoRoot();
    }

    /// <summary>Gets the resolved repository root.</summary>
    public string RepoRoot { get; }

    /// <summary>
    /// Resolves the highest-versioned locally-built <c>Gsharp.NET.Sdk</c> nupkg
    /// under <c>out/bin/&lt;Config&gt;/nupkgs/</c>.
    /// </summary>
    /// <param name="repoRoot">The repository root.</param>
    /// <param name="config">The build config to probe (e.g. <c>Release</c>).</param>
    /// <returns>The nupkg path and parsed version, or <see langword="null"/> when none exists.</returns>
    public static (string NupkgPath, string Version)? ResolveLocalSdkPackage(string repoRoot, string config = "Release")
    {
        if (string.IsNullOrEmpty(repoRoot))
        {
            return null;
        }

        var configs = string.IsNullOrEmpty(config)
            ? new[] { "Release", "Debug" }
            : new[] { config, "Release", "Debug" };

        foreach (string cfg in configs.Distinct(StringComparer.Ordinal))
        {
            string nupkgDir = Path.Combine(repoRoot, "out", "bin", cfg, "nupkgs");
            if (!Directory.Exists(nupkgDir))
            {
                continue;
            }

            (string Path, string Version)? best = null;
            foreach (string file in Directory.EnumerateFiles(nupkgDir, SdkPackagePrefix + "*.nupkg"))
            {
                string version = ParseVersion(Path.GetFileName(file));
                if (version is null)
                {
                    continue;
                }

                if (best is null || CompareVersions(version, best.Value.Version) > 0)
                {
                    best = (file, version);
                }
            }

            if (best is not null)
            {
                return best;
            }
        }

        return null;
    }

    /// <summary>
    /// Runs a translated G# library + xUnit test project and returns the parsed
    /// per-test outcomes.
    /// </summary>
    /// <param name="project">The translated G# test project to build and run.</param>
    /// <param name="workDir">The directory to scaffold the project under.</param>
    /// <returns>The run result (build status, output, TRX path, parsed outcomes).</returns>
    public virtual GsharpTestRunResult Run(GsharpTestProject project, string workDir)
    {
        if (project is null)
        {
            throw new ArgumentNullException(nameof(project));
        }

        if (string.IsNullOrEmpty(workDir))
        {
            throw new ArgumentException("A work directory is required.", nameof(workDir));
        }

        (string NupkgPath, string Version)? sdk = project.SdkVersion is not null
            ? (FindNupkgForVersion(project.SdkVersion), project.SdkVersion)
            : ResolveLocalSdkPackage(this.RepoRoot);

        if (sdk is null || sdk.Value.NupkgPath is null)
        {
            return GsharpTestRunResult.Unavailable(
                "No locally-built Gsharp.NET.Sdk nupkg was found under out/bin/<Config>/nupkgs/.");
        }

        EnsureInLocalFeed(this.RepoRoot, sdk.Value.NupkgPath);

        Directory.CreateDirectory(workDir);
        WriteIsolationBoundary(workDir);

        string libDir = Path.Combine(workDir, project.LibraryName);
        string testsDir = Path.Combine(workDir, project.TestsName);
        Directory.CreateDirectory(libDir);
        Directory.CreateDirectory(testsDir);

        File.WriteAllText(
            Path.Combine(libDir, project.LibraryName + ".gsproj"),
            LibraryProject(project, sdk.Value.Version));
        foreach (GsharpSourceFile file in project.LibraryFiles)
        {
            File.WriteAllText(Path.Combine(libDir, file.FileName), file.Source);
        }

        File.WriteAllText(
            Path.Combine(testsDir, project.TestsName + ".gsproj"),
            TestsProject(project, sdk.Value.Version));
        foreach (GsharpSourceFile file in project.TestFiles)
        {
            File.WriteAllText(Path.Combine(testsDir, file.FileName), file.Source);
        }

        string testsProjectPath = Path.Combine(testsDir, project.TestsName + ".gsproj");
        string trxDir = Path.Combine(workDir, "trx");
        Directory.CreateDirectory(trxDir);
        string trxPath = Path.Combine(trxDir, "results.trx");
        if (File.Exists(trxPath))
        {
            File.Delete(trxPath);
        }

        var args = new List<string>
        {
            "test",
            testsProjectPath,
            "-c",
            "Release",
            "--logger",
            "trx;LogFileName=results.trx",
            "--results-directory",
            trxDir,
        };

        // Issue #1749 mode 1: the generated project is scaffolded under
        // `workDir`, which NuGet restore reaches by walking *up* from looking
        // for `nuget.config`. When `--output` places `workDir` outside the repo
        // (a non-default `OutputRoot`), that walk never finds the repo
        // `nuget.config` that points restore at the local `.nugs` feed, so
        // restore always fails and library parity is silently disabled. Pass
        // the repo `nuget.config` explicitly so restore finds the feed
        // regardless of where the scaffold lives.
        // `dotnet test` forwards unrecognized args to MSBuild's VSTest target,
        // and MSBuild has no `--configfile` switch (that's a `dotnet restore`/
        // `dotnet nuget` only switch) - it fails hard with MSB1001. The
        // MSBuild-property form works for build/restore/test alike.
        string repoNugetConfig = Path.Combine(this.RepoRoot, "nuget.config");
        if (File.Exists(repoNugetConfig))
        {
            args.Add($"-p:RestoreConfigFile={repoNugetConfig}");
        }

        (int exit, string output) = this.RunDotnet(args, workDir);

        if (!File.Exists(trxPath))
        {
            return GsharpTestRunResult.BuildFailed(exit, output);
        }

        IReadOnlyList<TestCaseOutcome> results = TrxParser.ParseFile(trxPath);
        return GsharpTestRunResult.Ran(exit, output, trxPath, results);
    }

    private static string ParseVersion(string fileName)
    {
        if (!fileName.StartsWith(SdkPackagePrefix, StringComparison.Ordinal) ||
            !fileName.EndsWith(".nupkg", StringComparison.Ordinal))
        {
            return null;
        }

        return fileName.Substring(
            SdkPackagePrefix.Length,
            fileName.Length - SdkPackagePrefix.Length - ".nupkg".Length);
    }

    private static int CompareVersions(string left, string right)
    {
        // Compare the dotted numeric release components (e.g. 0.2.107) numerically
        // so 0.2.107 outranks 0.2.99, falling back to ordinal on the build suffix.
        (int[] LeftNumbers, string LeftSuffix) a = SplitVersion(left);
        (int[] RightNumbers, string RightSuffix) b = SplitVersion(right);

        int count = Math.Max(a.LeftNumbers.Length, b.RightNumbers.Length);
        for (int i = 0; i < count; i++)
        {
            int x = i < a.LeftNumbers.Length ? a.LeftNumbers[i] : 0;
            int y = i < b.RightNumbers.Length ? b.RightNumbers[i] : 0;
            if (x != y)
            {
                return x.CompareTo(y);
            }
        }

        return string.CompareOrdinal(a.LeftSuffix, b.RightSuffix);
    }

    private static (int[] Numbers, string Suffix) SplitVersion(string version)
    {
        if (string.IsNullOrEmpty(version))
        {
            return (Array.Empty<int>(), string.Empty);
        }

        int dash = version.IndexOf('-');
        string release = dash >= 0 ? version.Substring(0, dash) : version;
        string suffix = dash >= 0 ? version.Substring(dash + 1) : string.Empty;

        string[] parts = release.Split('.');
        var numbers = new int[parts.Length];
        for (int i = 0; i < parts.Length; i++)
        {
            numbers[i] = int.TryParse(parts[i], out int n) ? n : 0;
        }

        return (numbers, suffix);
    }

    private string FindNupkgForVersion(string version)
    {
        (string NupkgPath, string Version)? resolved = ResolveLocalSdkPackage(this.RepoRoot);
        if (resolved is not null &&
            string.Equals(resolved.Value.Version, version, StringComparison.Ordinal))
        {
            return resolved.Value.NupkgPath;
        }

        foreach (string cfg in new[] { "Release", "Debug" })
        {
            string candidate = Path.Combine(
                this.RepoRoot, "out", "bin", cfg, "nupkgs", SdkPackagePrefix + version + ".nupkg");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static void EnsureInLocalFeed(string repoRoot, string nupkgPath)
    {
        string feed = Path.Combine(repoRoot, ".nugs");
        Directory.CreateDirectory(feed);
        string target = Path.Combine(feed, Path.GetFileName(nupkgPath));
        if (!File.Exists(target))
        {
            File.Copy(nupkgPath, target);
        }
    }

    private static void WriteIsolationBoundary(string workDir)
    {
        // Sever the generated G# project from the repo-shared build the same way
        // the corpus does (no GitVersioning, StyleCop, or AssemblyName rewrite),
        // which otherwise breaks for the Gsharp language CodeDomProvider.
        const string Empty = "<Project>\n</Project>\n";
        File.WriteAllText(Path.Combine(workDir, "Directory.Build.props"), Empty);
        File.WriteAllText(Path.Combine(workDir, "Directory.Build.targets"), Empty);
    }

    private static string LibraryProject(GsharpTestProject project, string sdkVersion) =>
        $"<Project Sdk=\"{SdkPackageId}/{sdkVersion}\">\n" +
        "\n" +
        "  <PropertyGroup>\n" +
        "    <OutputType>Library</OutputType>\n" +
        "    <TargetFramework>net10.0</TargetFramework>\n" +
        $"    <RootNamespace>{project.LibraryRootNamespace}</RootNamespace>\n" +
        "  </PropertyGroup>\n" +
        "\n" +
        "</Project>\n";

    private static string TestsProject(GsharpTestProject project, string sdkVersion) =>
        $"<Project Sdk=\"{SdkPackageId}/{sdkVersion}\">\n" +
        "\n" +
        "  <PropertyGroup>\n" +
        "    <OutputType>Library</OutputType>\n" +
        "    <TargetFramework>net10.0</TargetFramework>\n" +
        $"    <RootNamespace>{project.TestsRootNamespace}</RootNamespace>\n" +
        "    <IsPackable>false</IsPackable>\n" +
        "    <IsTestProject>true</IsTestProject>\n" +
        "  </PropertyGroup>\n" +
        "\n" +
        "  <ItemGroup>\n" +
        "    <PackageReference Include=\"Microsoft.NET.Test.Sdk\" Version=\"17.11.1\" />\n" +
        "    <PackageReference Include=\"xunit\" Version=\"2.9.2\" />\n" +
        "    <PackageReference Include=\"xunit.runner.visualstudio\" Version=\"2.8.2\" />\n" +
        "  </ItemGroup>\n" +
        "\n" +
        "  <ItemGroup>\n" +
        $"    <ProjectReference Include=\"..\\{project.LibraryName}\\{project.LibraryName}.gsproj\" />\n" +
        "  </ItemGroup>\n" +
        "\n" +
        "</Project>\n";

    private static string FindRepoRoot()
    {
        string dir = Path.GetDirectoryName(typeof(GsharpTestProjectRunner).Assembly.Location);
        while (!string.IsNullOrEmpty(dir))
        {
            if (File.Exists(Path.Combine(dir, "nuget.config")) &&
                File.Exists(Path.Combine(dir, "GSharp.sln")))
            {
                return dir;
            }

            dir = Path.GetDirectoryName(dir);
        }

        return Environment.CurrentDirectory;
    }

    private (int Exit, string Output) RunDotnet(IReadOnlyList<string> arguments, string workingDirectory)
    {
        // `dotnet test` builds a project before running it, so allow more
        // headroom than the default; still bounded so a wedged run fails the
        // batch instead of hanging it (#1748).
        ProcessRunResult result = ProcessRunner.Run(
            "dotnet", arguments, workingDirectory, TimeSpan.FromMinutes(10));
        return (result.ExitCode, result.Output);
    }
}

/// <summary>
/// One G# source file (name + text) contributed to a generated test project.
/// </summary>
public sealed class GsharpSourceFile
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GsharpSourceFile"/> class.
    /// </summary>
    /// <param name="fileName">The <c>.gs</c> file name.</param>
    /// <param name="source">The G# source text.</param>
    public GsharpSourceFile(string fileName, string source)
    {
        this.FileName = fileName ?? throw new ArgumentNullException(nameof(fileName));
        this.Source = source ?? string.Empty;
    }

    /// <summary>Gets the <c>.gs</c> file name.</summary>
    public string FileName { get; }

    /// <summary>Gets the G# source text.</summary>
    public string Source { get; }
}

/// <summary>
/// A translated G# library + xUnit test project to build and run for stage-4
/// library parity (ADR-0115 §C/§E).
/// </summary>
public sealed class GsharpTestProject
{
    /// <summary>Gets or sets the library project name (folder + assembly).</summary>
    public string LibraryName { get; set; } = "Library";

    /// <summary>Gets or sets the library root namespace.</summary>
    public string LibraryRootNamespace { get; set; } = "Library";

    /// <summary>Gets or sets the translated G# library source files.</summary>
    public IReadOnlyList<GsharpSourceFile> LibraryFiles { get; set; } = Array.Empty<GsharpSourceFile>();

    /// <summary>Gets or sets the test project name (folder + assembly).</summary>
    public string TestsName { get; set; } = "Library.Tests";

    /// <summary>Gets or sets the test root namespace.</summary>
    public string TestsRootNamespace { get; set; } = "Library.Tests";

    /// <summary>Gets or sets the translated G# xUnit test source files.</summary>
    public IReadOnlyList<GsharpSourceFile> TestFiles { get; set; } = Array.Empty<GsharpSourceFile>();

    /// <summary>
    /// Gets or sets the explicit <c>Gsharp.NET.Sdk</c> version to pin; when
    /// <see langword="null"/> the highest locally-built nupkg is used.
    /// </summary>
    public string SdkVersion { get; set; }
}

/// <summary>
/// The outcome of a <see cref="GsharpTestProjectRunner.Run"/> invocation.
/// </summary>
public sealed class GsharpTestRunResult
{
    private GsharpTestRunResult(
        GsharpTestRunStatus status,
        int exitCode,
        string output,
        string trxPath,
        IReadOnlyList<TestCaseOutcome> results,
        string unavailableReason)
    {
        this.Status = status;
        this.ExitCode = exitCode;
        this.Output = output ?? string.Empty;
        this.TrxPath = trxPath;
        this.Results = results ?? Array.Empty<TestCaseOutcome>();
        this.UnavailableReason = unavailableReason;
    }

    /// <summary>Gets the run status.</summary>
    public GsharpTestRunStatus Status { get; }

    /// <summary>Gets the <c>dotnet test</c> exit code.</summary>
    public int ExitCode { get; }

    /// <summary>Gets the combined stdout+stderr.</summary>
    public string Output { get; }

    /// <summary>Gets the produced TRX path, or null when none was produced.</summary>
    public string TrxPath { get; }

    /// <summary>Gets the parsed per-test outcomes (empty unless the run produced a TRX).</summary>
    public IReadOnlyList<TestCaseOutcome> Results { get; }

    /// <summary>Gets the reason the run could not be attempted, when unavailable.</summary>
    public string UnavailableReason { get; }

    /// <summary>Gets a value indicating whether <c>dotnet test</c> produced a parseable TRX.</summary>
    public bool ProducedResults => this.Status == GsharpTestRunStatus.Ran;

    /// <summary>Creates an unavailable result (no local SDK to build against).</summary>
    /// <param name="reason">The reason the run could not be attempted.</param>
    /// <returns>An unavailable <see cref="GsharpTestRunResult"/>.</returns>
    public static GsharpTestRunResult Unavailable(string reason) =>
        new GsharpTestRunResult(GsharpTestRunStatus.Unavailable, 0, null, null, null, reason);

    /// <summary>Creates a build-failed result (no TRX was produced).</summary>
    /// <param name="exitCode">The <c>dotnet test</c> exit code.</param>
    /// <param name="output">The combined output.</param>
    /// <returns>A build-failed <see cref="GsharpTestRunResult"/>.</returns>
    public static GsharpTestRunResult BuildFailed(int exitCode, string output) =>
        new GsharpTestRunResult(GsharpTestRunStatus.BuildFailed, exitCode, output, null, null, null);

    /// <summary>Creates a ran result carrying the parsed outcomes.</summary>
    /// <param name="exitCode">The <c>dotnet test</c> exit code.</param>
    /// <param name="output">The combined output.</param>
    /// <param name="trxPath">The produced TRX path.</param>
    /// <param name="results">The parsed per-test outcomes.</param>
    /// <returns>A ran <see cref="GsharpTestRunResult"/>.</returns>
    public static GsharpTestRunResult Ran(
        int exitCode,
        string output,
        string trxPath,
        IReadOnlyList<TestCaseOutcome> results) =>
        new GsharpTestRunResult(GsharpTestRunStatus.Ran, exitCode, output, trxPath, results, null);
}
