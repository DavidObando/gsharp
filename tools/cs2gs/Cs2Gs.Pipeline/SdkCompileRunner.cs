// <copyright file="SdkCompileRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Opt-in stage-2 compile path (issue #2261): instead of invoking <c>gsc</c>
/// directly, builds the emitted G# with <c>dotnet build</c> against the
/// locally-built <c>Gsharp.NET.Sdk</c>. The SDK's gsgen MSBuild targets run the
/// real Roslyn source generators (e.g. CommunityToolkit.Mvvm's
/// <c>[ObservableProperty]</c>/<c>[RelayCommand]</c>, <c>[LoggerMessage]</c>)
/// against the referenced NuGet packages the way a real MSBuild build of the
/// original C# project would, which the direct-gsc path — a bare
/// <c>MetadataLoadContext</c> over an explicit reference/analyzer list — does
/// not reproduce. This is the dominant remaining Oahu-migration blocker.
/// The gsc-direct path (<see cref="CompileStage"/> default) remains unchanged;
/// this runner is only exercised when <see cref="PipelineOptions.CompileViaSdk"/>
/// is set.
/// </summary>
public sealed class SdkCompileRunner
{
    private const string SdkPackageId = "Gsharp.NET.Sdk";
    private const string SdkPackagePrefix = SdkPackageId + ".";

    // Matches a generic MSBuild/NuGet/CS error line, e.g.
    // `... : error NU1101: ...` or `... : error CS0246: ...`, used only as a
    // last-resort fallback when no structured GSxxxx diagnostic was parsed.
    private static readonly Regex GenericErrorPattern = new Regex(
        @":\s+error\s+(?<code>[A-Za-z]+\d+):\s*(?<msg>.*)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // The well-known NuGet package-asset directories that follow an
    // `{id}/{version}/` pair under a packages cache root (generic detector,
    // not specific to any single package).
    private static readonly HashSet<string> KnownAssetDirectories = new HashSet<string>(
        StringComparer.OrdinalIgnoreCase)
    {
        "lib", "ref", "analyzers", "runtimes", "build", "buildTransitive", "contentFiles", "tools",
    };

    /// <summary>
    /// Builds the supplied G# files via <c>dotnet build</c> against the
    /// locally-built <c>Gsharp.NET.Sdk</c>.
    /// </summary>
    /// <param name="appRunDir">The per-app output directory to scaffold the build project under.</param>
    /// <param name="projectName">The source project name to preserve for the generated <c>.gsproj</c> and assembly.</param>
    /// <param name="gsFilePaths">The absolute paths of the emitted G# files to compile, in compile order.</param>
    /// <param name="target">The output kind (exe or library).</param>
    /// <param name="referencePaths">
    /// The same reference set the gsc-direct path would pass via <c>/reference:</c>
    /// (app sibling assemblies, the shared framework, and external NuGet package
    /// assemblies). Reconstructed here into <c>PackageReference</c>/<c>Reference</c>
    /// MSBuild items instead.
    /// </param>
    /// <param name="analyzerPaths">The analyzer/generator assembly paths (issue #2215).</param>
    /// <param name="additionalFiles">The source generator inputs, including AXAML item metadata (issue #2223).</param>
    /// <param name="rootNamespace">The root namespace to set on the project, or <see langword="null"/>.</param>
    /// <param name="config">The build configuration (e.g. <c>Release</c>).</param>
    /// <param name="declaredPackageReferences">
    /// The source project's declared build/dev-only <c>PackageReference</c>s
    /// (issue #2267) — e.g. a version-bumped <c>Nerdbank.GitVersioning</c> — to
    /// re-declare in the isolated gsproj even though they contribute no
    /// compile-time reference DLL for <see cref="PartitionReferences"/> to
    /// recover. May be <see langword="null"/> or empty.
    /// </param>
    /// <returns>The compile result, or an unavailable result when no local SDK nupkg can be found.</returns>
    public SdkCompileResult Compile(
        string appRunDir,
        string projectName,
        IReadOnlyList<string> gsFilePaths,
        TargetKind target,
        IReadOnlyList<string> referencePaths,
        IReadOnlyList<string> analyzerPaths,
        IReadOnlyList<string> additionalFiles,
        string rootNamespace,
        string config,
        IReadOnlyList<DeclaredPackageReference> declaredPackageReferences = null)
    {
        if (string.IsNullOrEmpty(appRunDir))
        {
            throw new ArgumentException("An app run directory is required.", nameof(appRunDir));
        }

        if (string.IsNullOrWhiteSpace(projectName))
        {
            throw new ArgumentException("A project name is required.", nameof(projectName));
        }

        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        (string NupkgPath, string Version)? sdk =
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, config) ??
            ResolveFallbackSdkPackageFromLocalFeed(repoRoot);

        if (sdk is null || sdk.Value.NupkgPath is null)
        {
            return SdkCompileResult.Unavailable(
                "No locally-built Gsharp.NET.Sdk nupkg was found under out/bin/<Config>/nupkgs/ or .nugs/.");
        }

        GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, sdk.Value.NupkgPath);

        Directory.CreateDirectory(appRunDir);
        GsharpTestProjectRunner.WriteIsolationBoundary(appRunDir);
        WriteLocalNugetConfig(appRunDir, repoRoot);

        string nugetPackagesRoot = ResolveNugetPackagesRoot();
        string runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();

        (List<(string Id, string Version)> packages, List<string> references) =
            PartitionReferences(referencePaths ?? Array.Empty<string>(), nugetPackagesRoot, runtimeDir);

        var packageIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < packages.Count; i++)
        {
            packageIndex[packages[i].Id] = i;
        }

        var analyzerReferences = new List<string>();
        foreach (string analyzerPath in analyzerPaths ?? Array.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(analyzerPath))
            {
                continue;
            }

            (string Id, string Version)? owningPackage = TryParsePackageFromPath(analyzerPath, nugetPackagesRoot);
            if (owningPackage is not null)
            {
                // The PackageReference contributes its analyzer assets. Adding
                // the same DLL explicitly would run generators twice.
                AddOrUpgradePackage(packages, packageIndex, owningPackage.Value.Id, owningPackage.Value.Version);
                continue;
            }

            analyzerReferences.Add(Path.GetFullPath(analyzerPath));
        }

        // Issue #2267: a declared build/dev-only package (nbgv) that also
        // resolved a compile-time DLL is already covered by `packages` above;
        // only the ones DLL reconstruction could never see need to be added
        // here, carrying the PrivateAssets/IncludeAssets metadata `packages`
        // has no room for.
        var declaredOnlyPackages = new List<DeclaredPackageReference>();
        foreach (DeclaredPackageReference declared in declaredPackageReferences ?? Array.Empty<DeclaredPackageReference>())
        {
            if (declared is null || string.IsNullOrWhiteSpace(declared.Id) || packageIndex.ContainsKey(declared.Id))
            {
                continue;
            }

            declaredOnlyPackages.Add(declared);
        }

        string projectPath = Path.Combine(appRunDir, projectName + ".gsproj");
        string projectXml = BuildProjectXml(
            sdk.Value.Version,
            target,
            rootNamespace,
            gsFilePaths ?? Array.Empty<string>(),
            packages,
            references,
            analyzerReferences,
            declaredOnlyPackages,
            additionalFiles);
        File.WriteAllText(projectPath, projectXml);

        var args = new List<string> { "build", projectPath, "-c", config ?? "Release" };
        string repoNugetConfig = Path.Combine(repoRoot, "nuget.config");
        if (File.Exists(repoNugetConfig))
        {
            // MSBuild has no `--configfile` switch (that is a `dotnet restore`/
            // `dotnet nuget` only switch, and fails hard with MSB1001 under
            // `dotnet build`); the MSBuild-property form works for
            // restore/build alike (mirrors GsharpTestProjectRunner.Run).
            args.Add("-p:RestoreConfigFile=" + repoNugetConfig);
        }

        ProcessRunResult result = ProcessRunner.Run("dotnet", args, appRunDir, TimeSpan.FromMinutes(10));
        File.WriteAllText(Path.Combine(appRunDir, "sdk.build.log"), result.Output ?? string.Empty);

        IReadOnlyList<GscDiagnostic> diagnostics = GscInvoker.ParseDiagnostics(result.Output);
        if (result.ExitCode != 0 && diagnostics.Count(d => d.IsError) == 0)
        {
            GscDiagnostic synthetic = SynthesizeFallbackDiagnostic(result, gsFilePaths);
            if (synthetic is not null)
            {
                diagnostics = diagnostics.Append(synthetic).ToList();
            }
        }

        string assemblyPath = FindEmittedAssembly(appRunDir, projectName, config);
        return SdkCompileResult.Completed(result.ExitCode, result.Output, diagnostics, assemblyPath);
    }

    /// <summary>
    /// Partitions a flat reference-path list into reconstructed
    /// <c>PackageReference</c> ids/versions (for dlls that live under a NuGet
    /// packages cache) and the remaining loose/sibling <c>Reference</c> paths.
    /// Shared-framework assemblies (matched by file name against
    /// <paramref name="runtimeDir"/>) are dropped entirely — the SDK's own
    /// target framework reference already supplies them. Exposed
    /// <see langword="internal"/> so it is unit-testable without a live NuGet
    /// cache or a real <c>dotnet build</c>.
    /// </summary>
    /// <param name="referencePaths">The flat reference-path list (gsc's <c>/reference:</c> set).</param>
    /// <param name="nugetPackagesRoot">The NuGet global-packages folder (<c>NUGET_PACKAGES</c> or <c>~/.nuget/packages</c>).</param>
    /// <param name="runtimeDir">The shared-framework directory to exclude.</param>
    /// <returns>The reconstructed package id/version pairs and the remaining loose reference paths.</returns>
    internal static (List<(string Id, string Version)> Packages, List<string> References) PartitionReferences(
        IEnumerable<string> referencePaths, string nugetPackagesRoot, string runtimeDir)
    {
        var packages = new List<(string Id, string Version)>();
        var packageIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var references = new List<string>();

        var runtimeFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrEmpty(runtimeDir) && Directory.Exists(runtimeDir))
        {
            foreach (string file in Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly))
            {
                runtimeFileNames.Add(Path.GetFileName(file));
            }
        }

        foreach (string path in referencePaths ?? Array.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                continue;
            }

            (string Id, string Version)? package = TryParsePackageFromPath(path, nugetPackagesRoot);
            if (package is not null)
            {
                AddOrUpgradePackage(packages, packageIndex, package.Value.Id, package.Value.Version);
                continue;
            }

            if (runtimeFileNames.Contains(Path.GetFileName(path)))
            {
                // Shared-framework assembly copy: the SDK's TargetFramework
                // already supplies these; skip to avoid a double identity.
                continue;
            }

            references.Add(path);
        }

        return (packages, references);
    }

    /// <summary>
    /// Attempts to parse a NuGet package id/version out of an assembly path
    /// living under a packages cache. Honors <paramref name="nugetPackagesRoot"/>
    /// when the path is rooted there, and otherwise falls back to a generic
    /// scan for any <c>.../packages/{id}/{version}/{asset-dir}/...</c> shape
    /// (so a differently-configured cache root, e.g. a CI-specific
    /// <c>NUGET_PACKAGES</c>, is still recognized).
    /// </summary>
    /// <param name="path">The candidate assembly path.</param>
    /// <param name="nugetPackagesRoot">The known packages root, or <see langword="null"/>.</param>
    /// <returns>The parsed id/version pair, or <see langword="null"/> when the path is not a packages-cache path.</returns>
    internal static (string Id, string Version)? TryParsePackageFromPath(string path, string nugetPackagesRoot)
    {
        if (string.IsNullOrEmpty(path))
        {
            return null;
        }

        string normalized = path.Replace('\\', '/');

        if (!string.IsNullOrEmpty(nugetPackagesRoot))
        {
            string root = nugetPackagesRoot.Replace('\\', '/').TrimEnd('/') + "/";
            if (normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                string remainder = normalized.Substring(root.Length);
                string[] rootedSegments = remainder.Split('/');
                if (rootedSegments.Length >= 2 &&
                    !string.IsNullOrEmpty(rootedSegments[0]) &&
                    !string.IsNullOrEmpty(rootedSegments[1]))
                {
                    return (rootedSegments[0], rootedSegments[1]);
                }
            }
        }

        string[] segments = normalized.Split('/');
        for (int i = 0; i <= segments.Length - 4; i++)
        {
            if (string.Equals(segments[i], "packages", StringComparison.OrdinalIgnoreCase) &&
                KnownAssetDirectories.Contains(segments[i + 3]) &&
                !string.IsNullOrEmpty(segments[i + 1]) &&
                !string.IsNullOrEmpty(segments[i + 2]))
            {
                return (segments[i + 1], segments[i + 2]);
            }
        }

        return null;
    }

    /// <summary>
    /// Renders the migrated, source-named <c>.gsproj</c> XML text: the SDK-project header,
    /// build properties, <c>@(Compile)</c> items, <c>@(PackageReference)</c>
    /// (both the reconstructed-from-DLL set and the declared build/dev-only set,
    /// issue #2267), <c>@(Reference)</c>, and <c>@(Analyzer)</c> items. Exposed
    /// <see langword="internal"/> so the package/analyzer item emission is
    /// unit-testable without a live NuGet cache or a real <c>dotnet build</c>.
    /// </summary>
    /// <param name="sdkVersion">The resolved <c>Gsharp.NET.Sdk</c> version.</param>
    /// <param name="target">The output kind (exe or library).</param>
    /// <param name="rootNamespace">The root namespace to set on the project, or <see langword="null"/>.</param>
    /// <param name="gsFilePaths">The absolute paths of the emitted G# files to compile, in compile order.</param>
    /// <param name="packages">The <c>PackageReference</c> id/version pairs reconstructed from compile-time DLLs.</param>
    /// <param name="references">The remaining loose/sibling <c>Reference</c> paths.</param>
    /// <param name="analyzerReferences">The analyzer/generator assembly paths (issue #2215).</param>
    /// <param name="declaredPackageReferences">
    /// The source project's declared build/dev-only <c>PackageReference</c>s
    /// (issue #2267) to re-declare even though they contributed no compile-time
    /// DLL to <paramref name="packages"/>.
    /// </param>
    /// <param name="additionalFiles">The source generator inputs to emit as project items.</param>
    /// <returns>The full <c>.gsproj</c> XML text.</returns>
    internal static string BuildProjectXml(
        string sdkVersion,
        TargetKind target,
        string rootNamespace,
        IReadOnlyList<string> gsFilePaths,
        IReadOnlyList<(string Id, string Version)> packages,
        IReadOnlyList<string> references,
        IReadOnlyList<string> analyzerReferences,
        IReadOnlyList<DeclaredPackageReference> declaredPackageReferences = null,
        IReadOnlyList<string> additionalFiles = null)
    {
        declaredPackageReferences ??= Array.Empty<DeclaredPackageReference>();
        additionalFiles ??= Array.Empty<string>();
        string outputType = target == TargetKind.Exe ? "Exe" : "Library";
        var sb = new StringBuilder();
        sb.Append("<Project Sdk=\"").Append(SdkPackageId).Append('/').Append(sdkVersion).Append("\">\n");
        sb.Append('\n');
        sb.Append("  <PropertyGroup>\n");
        sb.Append("    <OutputType>").Append(outputType).Append("</OutputType>\n");
        sb.Append("    <TargetFramework>net10.0</TargetFramework>\n");
        sb.Append("    <Nullable>enable</Nullable>\n");
        sb.Append("    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>\n");
        sb.Append("    <Deterministic>true</Deterministic>\n");
        sb.Append("    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>\n");
        if (!string.IsNullOrEmpty(rootNamespace))
        {
            sb.Append("    <RootNamespace>").Append(rootNamespace).Append("</RootNamespace>\n");
        }

        sb.Append("  </PropertyGroup>\n");
        sb.Append('\n');
        sb.Append("  <ItemGroup>\n");
        foreach (string gsFile in gsFilePaths)
        {
            sb.Append("    <Compile Include=\"").Append(gsFile).Append("\" />\n");
        }

        sb.Append("  </ItemGroup>\n");

        if (packages.Count > 0 || declaredPackageReferences.Count > 0)
        {
            sb.Append('\n');
            sb.Append("  <ItemGroup>\n");
            foreach ((string id, string version) in packages)
            {
                sb.Append("    <PackageReference Include=\"").Append(id)
                    .Append("\" Version=\"").Append(version).Append("\" />\n");
            }

            // Issue #2267: build/dev-only packages (e.g. Nerdbank.GitVersioning)
            // that contributed no compile-time DLL and so are absent from
            // `packages` above, re-declared here so their MSBuild source
            // generators still run under `dotnet build`.
            foreach (DeclaredPackageReference declared in declaredPackageReferences)
            {
                sb.Append("    <PackageReference Include=\"").Append(declared.Id)
                    .Append("\" Version=\"").Append(declared.Version).Append('"');
                if (!string.IsNullOrEmpty(declared.PrivateAssets))
                {
                    sb.Append(" PrivateAssets=\"").Append(declared.PrivateAssets).Append('"');
                }

                if (!string.IsNullOrEmpty(declared.IncludeAssets))
                {
                    sb.Append(" IncludeAssets=\"").Append(declared.IncludeAssets).Append('"');
                }

                sb.Append(" />\n");
            }

            sb.Append("  </ItemGroup>\n");
        }

        if (references.Count > 0)
        {
            sb.Append('\n');
            sb.Append("  <ItemGroup>\n");
            foreach (string reference in references)
            {
                sb.Append("    <Reference Include=\"").Append(Path.GetFullPath(reference)).Append("\" />\n");
            }

            sb.Append("  </ItemGroup>\n");
        }

        if (analyzerReferences.Count > 0)
        {
            sb.Append('\n');
            sb.Append("  <ItemGroup>\n");
            foreach (string analyzerReference in analyzerReferences)
            {
                sb.Append("    <Analyzer Include=\"").Append(analyzerReference).Append("\" />\n");
            }

            sb.Append("  </ItemGroup>\n");
        }

        if (additionalFiles.Count > 0)
        {
            sb.Append('\n');
            sb.Append("  <ItemGroup>\n");
            foreach (string spec in additionalFiles)
            {
                string[] segments = spec.Split(';', StringSplitOptions.RemoveEmptyEntries);
                string path = segments[0];
                bool isAvaloniaXaml = segments.Skip(1).Any(
                    s => string.Equals(s, "SourceItemGroup=AvaloniaXaml", StringComparison.OrdinalIgnoreCase));
                string itemName = isAvaloniaXaml ? "AvaloniaXaml" : "AdditionalFiles";
                sb.Append("    <").Append(itemName).Append(" Include=\"").Append(path).Append("\" />\n");
            }

            sb.Append("  </ItemGroup>\n");
        }

        sb.Append('\n');
        sb.Append("</Project>\n");
        return sb.ToString();
    }

    /// <summary>
    /// Writes a <c>nuget.config</c> directly into <paramref name="appRunDir"/>
    /// pointing at the repo's <c>.nugs</c> local feed (by absolute path) plus
    /// nuget.org. MSBuild's SDK resolver (which resolves <c>Sdk="Gsharp.NET.Sdk/…"</c>
    /// before evaluation even starts, independent of any <c>-p:RestoreConfigFile</c>
    /// passed to the build) discovers <c>nuget.config</c> by walking up from the
    /// project directory the same way <c>dotnet restore</c> does; when
    /// <paramref name="appRunDir"/> lives outside the repo (any <c>--out</c>
    /// other than a repo-nested path), that walk never reaches the repo's own
    /// <c>nuget.config</c> and the SDK version fails to resolve (MSB4236).
    /// Writing an equivalent config in the same directory as the generated
    /// <c>.gsproj</c> makes it discoverable unconditionally.
    /// </summary>
    /// <param name="appRunDir">The directory the <c>.gsproj</c> is written to.</param>
    /// <param name="repoRoot">The repository root containing the <c>.nugs</c> feed.</param>
    private static void WriteLocalNugetConfig(string appRunDir, string repoRoot)
    {
        string localFeed = Path.Combine(repoRoot, ".nugs");
        var sb = new StringBuilder();
        sb.Append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
        sb.Append("<configuration>\n");
        sb.Append("  <packageSources>\n");
        sb.Append("    <clear />\n");
        sb.Append("    <add key=\"NuGet official package source\" value=\"https://api.nuget.org/v3/index.json\" />\n");
        sb.Append("    <add key=\"Gsharp local packages\" value=\"").Append(localFeed).Append("\" />\n");
        sb.Append("  </packageSources>\n");
        sb.Append("  <disabledPackageSources>\n");
        sb.Append("    <clear />\n");
        sb.Append("  </disabledPackageSources>\n");
        sb.Append("</configuration>\n");
        File.WriteAllText(Path.Combine(appRunDir, "nuget.config"), sb.ToString());
    }

    private static void AddOrUpgradePackage(
        List<(string Id, string Version)> packages, Dictionary<string, int> packageIndex, string id, string version)
    {
        if (packageIndex.TryGetValue(id, out int existingIndex))
        {
            (string Id, string Version) existing = packages[existingIndex];
            if (GsharpTestProjectRunner.CompareVersions(version, existing.Version) > 0)
            {
                packages[existingIndex] = (existing.Id, version);
            }

            return;
        }

        packageIndex[id] = packages.Count;
        packages.Add((id, version));
    }

    private static string ResolveNugetPackagesRoot()
    {
        string envOverride = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
        if (!string.IsNullOrEmpty(envOverride))
        {
            return envOverride;
        }

        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return string.IsNullOrEmpty(home) ? null : Path.Combine(home, ".nuget", "packages");
    }

    private static (string NupkgPath, string Version)? ResolveFallbackSdkPackageFromLocalFeed(string repoRoot)
    {
        string feed = Path.Combine(repoRoot, ".nugs");
        if (!Directory.Exists(feed))
        {
            return null;
        }

        (string Path, string Version)? best = null;
        foreach (string file in Directory.EnumerateFiles(feed, SdkPackagePrefix + "*.nupkg"))
        {
            string version = GsharpTestProjectRunner.ParseVersion(Path.GetFileName(file));
            if (version is null)
            {
                continue;
            }

            if (best is null || GsharpTestProjectRunner.CompareVersions(version, best.Value.Version) > 0)
            {
                best = (file, version);
            }
        }

        return best;
    }

    private static GscDiagnostic SynthesizeFallbackDiagnostic(ProcessRunResult result, IReadOnlyList<string> gsFilePaths)
    {
        string relativeFile = gsFilePaths is { Count: > 0 } ? Path.GetFileName(gsFilePaths[0]) : "unknown";

        if (!string.IsNullOrEmpty(result.Output))
        {
            foreach (string rawLine in result.Output.Replace("\r\n", "\n").Split('\n'))
            {
                Match match = GenericErrorPattern.Match(rawLine.Trim());
                if (match.Success)
                {
                    string message = "dotnet build: " + match.Groups["code"].Value + ": " + match.Groups["msg"].Value.Trim();
                    return new GscDiagnostic(match.Groups["code"].Value, message, "error", relativeFile, 1, 1);
                }
            }
        }

        string fallbackMessage = "dotnet build exited with code " + result.ExitCode + " and no parseable diagnostic.";
        return new GscDiagnostic("GS9999", fallbackMessage, "error", relativeFile, 1, 1);
    }

    private static string FindEmittedAssembly(string appRunDir, string projectName, string config)
    {
        string binDir = Path.Combine(appRunDir, "bin", config ?? "Release", "net10.0");
        if (!Directory.Exists(binDir))
        {
            return null;
        }

        string expected = Path.Combine(binDir, projectName + ".dll");
        return File.Exists(expected) ? expected : Directory.EnumerateFiles(binDir, "*.dll").FirstOrDefault();
    }
}

/// <summary>
/// The outcome of an <see cref="SdkCompileRunner.Compile"/> invocation.
/// </summary>
public sealed class SdkCompileResult
{
    private SdkCompileResult(
        bool isAvailable,
        string unavailableReason,
        int exitCode,
        string output,
        IReadOnlyList<GscDiagnostic> diagnostics,
        string emittedAssemblyPath)
    {
        this.IsAvailable = isAvailable;
        this.UnavailableReason = unavailableReason;
        this.ExitCode = exitCode;
        this.Output = output;
        this.Diagnostics = diagnostics ?? Array.Empty<GscDiagnostic>();
        this.EmittedAssemblyPath = emittedAssemblyPath;
    }

    /// <summary>Gets a value indicating whether a local SDK build could be attempted at all.</summary>
    public bool IsAvailable { get; }

    /// <summary>Gets the reason the SDK build was unavailable, or <see langword="null"/> when available.</summary>
    public string UnavailableReason { get; }

    /// <summary>Gets the <c>dotnet build</c> process exit code.</summary>
    public int ExitCode { get; }

    /// <summary>Gets the combined stdout+stderr of the <c>dotnet build</c> invocation.</summary>
    public string Output { get; }

    /// <summary>Gets the parsed diagnostics.</summary>
    public IReadOnlyList<GscDiagnostic> Diagnostics { get; }

    /// <summary>Gets the error-severity diagnostics.</summary>
    public IReadOnlyList<GscDiagnostic> Errors => this.Diagnostics.Where(d => d.IsError).ToList();

    /// <summary>Gets the absolute path of the built assembly, or <see langword="null"/> when not found.</summary>
    public string EmittedAssemblyPath { get; }

    /// <summary>Gets a value indicating whether the build passed: exit 0 and zero error-severity diagnostics.</summary>
    public bool Succeeded => this.IsAvailable && this.ExitCode == 0 && this.Errors.Count == 0;

    /// <summary>Creates an "SDK unavailable" result so the caller can fall back to the gsc-direct path.</summary>
    /// <param name="reason">A human-readable reason.</param>
    /// <returns>The unavailable result.</returns>
    public static SdkCompileResult Unavailable(string reason) =>
        new SdkCompileResult(false, reason, -1, null, Array.Empty<GscDiagnostic>(), null);

    /// <summary>Creates a completed-build result.</summary>
    /// <param name="exitCode">The process exit code.</param>
    /// <param name="output">The combined stdout+stderr.</param>
    /// <param name="diagnostics">The parsed diagnostics.</param>
    /// <param name="emittedAssemblyPath">The built assembly path, or <see langword="null"/>.</param>
    /// <returns>The completed result.</returns>
    public static SdkCompileResult Completed(
        int exitCode, string output, IReadOnlyList<GscDiagnostic> diagnostics, string emittedAssemblyPath) =>
        new SdkCompileResult(true, null, exitCode, output, diagnostics, emittedAssemblyPath);
}
