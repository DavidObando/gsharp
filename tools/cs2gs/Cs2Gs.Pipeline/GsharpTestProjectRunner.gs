// <copyright file="GsharpTestProjectRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Security
import System.Security.Cryptography

/// The status of a (cref:GsharpTestProjectRunner.Run) invocation.
enum GsharpTestRunStatus {
    Unavailable,
    BuildFailed,
    Ran
}

/// The live library xUnit parity orchestration for stage 4 (ADR-0115 §C/§E):
/// given a translated G# library and its translated G# xUnit tests, this writes
/// an isolated G# test project that consumes the pinned
/// `Gsharp.NET.Sdk` (copied into the repo's `.nugs` feed when available locally and pinned in
/// the generated `.gsproj`), runs `dotnet test` producing a TRX, and
/// parses it into the `{name, outcome}` set the comparison engine consumes.
/// All process I/O is local — it only shells out to `dotnet test`; there is
/// no network egress beyond NuGet restore and no keys. An isolation
/// `Directory.Build.props`/`.targets` pair is written at the work-dir
/// root so the repo-shared build (Nerdbank.GitVersioning, StyleCop) does not
/// apply to the generated G# project.
open class GsharpTestProjectRunner {
    /// Initializes a new instance of the (cref:GsharpTestProjectRunner) class.
    /// @param repoRoot The repository root (the directory containing `nuget.config` and the
    /// `.nugs` feed). When `null` it is discovered by
    /// walking up from this assembly's location.
    init(repoRoot string? = nil) {
        this.RepoRoot = repoRoot ?? FindRepoRoot()
    }

    /// Gets the resolved repository root.
    prop RepoRoot string? {
        get;
    }

    /// Runs a translated G# library + xUnit test project and returns the parsed
    /// per-test outcomes.
    /// @param project The translated G# test project to build and run.
    /// @param workDir The directory to scaffold the project under.
    /// @returns The run result (build status, output, TRX path, parsed outcomes).
    open func Run(project GsharpTestProject?, workDir string) GsharpTestRunResult {
        if project == nil {
            throw ArgumentNullException("project")
        }
        if string.IsNullOrEmpty(workDir) {
            throw ArgumentException("A work directory is required.", "workDir")
        }
        let sdk = if project.SdkVersion != nil {
            (FindNupkgForVersion(project.SdkVersion), project.SdkVersion!!)
        } else {
            ResolveLocalSdkPackage(this.RepoRoot)
        }
        if sdk == nil {
            return GsharpTestRunResult.Unavailable(
                "No locally-built Gsharp.NET.Sdk nupkg was found under out/bin/<Config>/nupkgs/."
            )
        }
        if sdk.NupkgPath != nil {
            EnsureInLocalFeed(this.RepoRoot, sdk.NupkgPath)
        }
        Directory.CreateDirectory(workDir)
        WriteIsolationBoundary(workDir)
        let libDir = Path.Combine(workDir, project.LibraryName)
        let testsDir = Path.Combine(workDir, project.TestsName)
        Directory.CreateDirectory(libDir)
        Directory.CreateDirectory(testsDir)
        File.WriteAllText(Path.Combine(libDir, project.LibraryName + ".gsproj"), LibraryProject(project, sdk.Version))
        for file in project.LibraryFiles {
            File.WriteAllText(Path.Combine(libDir, file.FileName), file.Source)
        }
        File.WriteAllText(Path.Combine(testsDir, project.TestsName + ".gsproj"), TestsProject(project, sdk.Version))
        for file in project.TestFiles {
            File.WriteAllText(Path.Combine(testsDir, file.FileName), file.Source)
        }
        let testsProjectPath = Path.Combine(testsDir, project.TestsName + ".gsproj")
        let trxDir = Path.Combine(workDir, "trx")
        Directory.CreateDirectory(trxDir)
        let trxPath = Path.Combine(trxDir, "results.trx")
        if File.Exists(trxPath) {
            File.Delete(trxPath)
        }
        let args = List[string]{
            "test",
            testsProjectPath,
            "-c",
            "Release",
            "--logger",
            "trx;LogFileName=results.trx",
            "--results-directory",
            trxDir
        }
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
        let repoNugetConfig = Path.Combine(this.RepoRoot!!, "nuget.config")
        if File.Exists(repoNugetConfig) {
            args.Add("-p:RestoreConfigFile=$repoNugetConfig")
        }
        // Bug #1752 (part 1): NuGet's shared global-packages folder keys its
        // extracted package cache on id+version alone, so a same-version
        // rebuilt SDK nupkg copied into `.nugs` (see EnsureInLocalFeed) would
        // still resolve to the stale extraction left behind by an earlier run.
        // Point restore at a packages folder scoped to this work dir so every
        // run extracts the current `.nugs` nupkg contents fresh, regardless of
        // what is already sitting in the shared global cache.
        let isolatedPackagesPath = Path.Combine(workDir, ".nuget-packages")
        args.Add("-p:RestorePackagesPath=$isolatedPackagesPath")
        let (exit, output) = this.RunDotnet(args, workDir)
        if !File.Exists(trxPath) {
            return GsharpTestRunResult.BuildFailed(exit, output)
        }
        let results = TrxParser.ParseFile(trxPath)
        return GsharpTestRunResult.Ran(exit, output, trxPath, results)
    }

    private func FindNupkgForVersion(version string?) string? {
        return FindLocalPackageVersion(this.RepoRoot, SdkPackageId, version)
    }

    private func RunDotnet(arguments IReadOnlyList[string], workingDirectory string)(Exit int32, Output string) {
        // `dotnet test` builds a project before running it, so allow more
        // headroom than the default; still bounded so a wedged run fails the
        // batch instead of hanging it (#1748).
        let result = ProcessRunner.Run(
            "dotnet",
            arguments,
            workingDirectory,
            TimeSpan.FromMinutes(10),
            Dictionary[string, string]{["NUGET_PACKAGES"] = Path.Combine(workingDirectory, ".nuget-packages")}
        )
        return (result.ExitCode, result.Output)
    }

    shared {
        /// The stage-4 child-process contract for the original, read-only C# source
        /// tree. The variable is set only for `dotnet test --no-build`.
        const SourceRootEnvironmentVariable string = "CS2GS_TEST_SOURCE_ROOT"

        private const SdkPackageId string = "Gsharp.NET.Sdk"
        private const SdkPackagePrefix string = SdkPackageId + "."

        /// Resolves the most recently built local `Gsharp.NET.Sdk` nupkg
        /// under `out/bin/<Config>/nupkgs/`.
        /// @param repoRoot The repository root.
        /// @param config The build config to probe (e.g. `Release`).
        /// @returns The nupkg path and parsed version, or `null` when none exists.
        func ResolveLocalSdkPackage(repoRoot string?, config string? = "Release")(
            NupkgPath string,
            Version string
        )? -> ResolveLocalPackage(repoRoot, SdkPackageId, config)

        /// Resolves the most recently built local nupkg for [`packageId`](paramref)
        /// under `out/bin/<Config>/nupkgs/`. Generalizes
        /// (cref:ResolveLocalSdkPackage) (issue #3780) so any locally-packed
        /// GSharp package — not only `Gsharp.NET.Sdk` — can be resolved the
        /// same way.
        /// @param repoRoot The repository root.
        /// @param packageId The NuGet package id to resolve.
        /// @param config The build config to probe (e.g. `Release`).
        /// @returns The nupkg path and parsed version, or `null` when none exists.
        internal func ResolveLocalPackage(repoRoot string?, packageId string, config string? = "Release")(
            NupkgPath string,
            Version string
        )? {
            if string.IsNullOrEmpty(repoRoot) {
                return nil
            }
            let configs = if string.IsNullOrEmpty(config) {
                []string{"Release", "Debug"}
            } else {
                []string{config!!, "Release", "Debug"}
            }
            for cfg in configs.Distinct(StringComparer.Ordinal) {
                let nupkgDir = Path.Combine(repoRoot, "out", "bin", cfg, "nupkgs")
                if !Directory.Exists(nupkgDir) {
                    continue
                }
                let best = ResolveNewestPackage(nupkgDir, packageId)
                if best != nil {
                    return best
                }
            }
            return nil
        }

        /// Finds a local nupkg of exactly [`version`](paramref) for
        /// [`packageId`](paramref): under `out/bin/<Config>/nupkgs/`
        /// (the probed config first, then Release, then Debug), then in the repo's
        /// `.nugs` feed. Unlike (cref:ResolveLocalPackage) it never
        /// substitutes a different version.
        /// @param repoRoot The repository root.
        /// @param packageId The NuGet package id.
        /// @param version The exact version required.
        /// @param config The build config to probe first.
        /// @returns The nupkg path, or `null` when no local copy exists.
        internal func FindLocalPackageVersion(
            repoRoot string?,
            packageId string,
            version string?,
            config string? = "Release"
        ) string? {
            if string.IsNullOrEmpty(repoRoot) {
                return nil
            }
            let fileName = packageId + "." + version + ".nupkg"
            let directories = List[string]()
            for cfg in[]string{config!!, "Release", "Debug"} {
                if !string.IsNullOrEmpty(cfg) {
                    directories.Add(Path.Combine(repoRoot, "out", "bin", cfg, "nupkgs"))
                }
            }
            directories.Add(Path.Combine(repoRoot, ".nugs"))
            for directory in directories.Distinct(StringComparer.Ordinal) {
                let candidate = Path.Combine(directory, fileName)
                if File.Exists(candidate) {
                    return candidate
                }
            }
            return nil
        }

        internal func ResolveNewestSdkPackage(directory string)(
            NupkgPath string,
            Version string
        )? -> ResolveNewestPackage(directory, SdkPackageId)

        /// Same selection policy as (cref:ResolveNewestSdkPackage) — newest
        /// write time, then highest SemVer, then ordinal name — generalized to any
        /// package id (issue #3780).
        /// @param directory The nupkg directory to scan.
        /// @param packageId The NuGet package id to match.
        /// @returns The nupkg path and parsed version, or `null` when none exists.
        internal func ResolveNewestPackage(directory string, packageId string)(NupkgPath string, Version string)? {
            if !Directory.Exists(directory) {
                return nil
            }
            let packagePrefix = packageId + "."
            var best(Path string, Version string, WrittenUtc DateTime)? = nil
            for file in Directory.EnumerateFiles(directory, packagePrefix + "*.nupkg") {
                let version string? = ParseVersion(Path.GetFileName(file), packagePrefix)
                if version == nil {
                    continue
                }
                let writtenUtc = File.GetLastWriteTimeUtc(file)
                let versionComparison = if best == nil {
                    0
                } else {
                    CompareVersions(version, best.Version)
                }
                if best == nil ||
                    writtenUtc > best!!.WrittenUtc ||
                    (
                    writtenUtc == best!!.WrittenUtc &&
                        (
                        versionComparison > 0 ||
                            (
                            versionComparison == 0 && string.CompareOrdinal(
                                Path.GetFileName(file),
                                Path.GetFileName(best!!.Path)
                            ) > 0
                        )
                    )
                ) {
                    // Exact write-time ties contain no portable recency signal.
                    // Prefer SemVer, then package name for equivalent versions.
                    best = (file, version, writtenUtc)
                }
            }
            return if best == nil {
                nil
            } else {
                (best.Path, best.Version)
            }
        }

        /// Compares two dotted-numeric SDK versions (with an optional prerelease
        /// suffix) per SemVer 2.0.0 §11 precedence: numeric release components
        /// compare numerically (so `1.10.0` outranks `1.9.0`), a version
        /// WITHOUT a prerelease tag outranks the same release WITH one (a
        /// prerelease precedes its release), and when both carry a prerelease tag
        /// its dot-separated identifiers are compared per §11.4 (numeric
        /// identifiers compare numerically and are lower than alphanumeric ones,
        /// which compare ordinally).
        /// @param left The left-hand version.
        /// @param right The right-hand version.
        /// @returns A negative, zero, or positive value as [`left`](paramref) is lower than, equal to, or
        /// higher than [`right`](paramref).
        internal func CompareVersions(left string, right string) int32 {
            let a(LeftNumbers[]int32, LeftSuffix string) = SplitVersion(left)
            let b(RightNumbers[]int32, RightSuffix string) = SplitVersion(right)
            let count = Math.Max(a.LeftNumbers.Length, b.RightNumbers.Length)
            for var i = 0; i < count; i++ {
                let x = if i < a.LeftNumbers.Length {
                    a.LeftNumbers[i]
                } else {
                    0
                }
                let y = if i < b.RightNumbers.Length {
                    b.RightNumbers[i]
                } else {
                    0
                }
                if x != y {
                    return x.CompareTo(y)
                }
            }
            let leftHasSuffix = a.LeftSuffix.Length > 0
            let rightHasSuffix = b.RightSuffix.Length > 0
            if leftHasSuffix != rightHasSuffix {
                // Absent prerelease tag (release) outranks a present one.
                return if leftHasSuffix {
                    -1
                } else {
                    1
                }
            }
            if !leftHasSuffix {
                return 0
            }
            return ComparePrereleaseIdentifiers(a.LeftSuffix, b.RightSuffix)
        }

        /// Copies [`nupkgPath`](paramref) into the repo's local `.nugs`
        /// feed, refreshing it when the destination already exists but its content
        /// differs from the source (a same-version rebuild), while leaving an
        /// unchanged nupkg untouched.
        /// @param repoRoot The repository root containing the `.nugs` feed.
        /// @param nupkgPath The source nupkg to stage.
        internal func EnsureInLocalFeed(repoRoot string?, nupkgPath string) {
            let feed = Path.Combine(repoRoot!!, ".nugs")
            Directory.CreateDirectory(feed)
            let target = Path.Combine(feed, Path.GetFileName(nupkgPath))
            // Bug #1752 (part 1): a rebuilt SDK nupkg with an unchanged version
            // string used to be silently skipped here (`if (!File.Exists(target))`),
            // pinning stale bits in the `.nugs` feed forever. Refresh whenever the
            // source nupkg's content actually differs from what is already staged,
            // so a same-version rebuild is picked up while an unchanged nupkg is
            // not needlessly re-copied.
            if File.Exists(target) && FilesAreIdentical(nupkgPath, target) {
                return
            }
            File.Copy(nupkgPath, target, overwrite: true)
        }

        internal func ParseVersion(fileName string) string? -> ParseVersion(fileName, SdkPackagePrefix)

        internal func ParseVersion(fileName string, packagePrefix string) string? {
            if !fileName.StartsWith(packagePrefix, StringComparison.Ordinal) || !fileName.EndsWith(
                ".nupkg",
                StringComparison.Ordinal
            ) {
                return nil
            }
            return fileName.Substring(packagePrefix.Length, fileName.Length - packagePrefix.Length - ".nupkg".Length)
        }

        internal func WriteIsolationBoundary(workDir string) {
            // Sever the generated G# project from the repo-shared build the same way
            // the corpus does (no GitVersioning, StyleCop, or AssemblyName rewrite),
            // which otherwise breaks for the Gsharp language CodeDomProvider.
            const Empty = `<Project>
</Project>
`
            let propsPath = Path.Combine(workDir, "Directory.Build.props")
            let targetsPath = Path.Combine(workDir, "Directory.Build.targets")
            if !File.Exists(propsPath) {
                File.WriteAllText(propsPath, Empty)
            }
            if !File.Exists(targetsPath) {
                File.WriteAllText(targetsPath, Empty)
            }
        }

        internal func FindRepoRoot() string? {
            let configuredRoot string? = Environment.GetEnvironmentVariable(SourceRootEnvironmentVariable)
            if !string.IsNullOrWhiteSpace(configuredRoot) {
                return ResolveConfiguredSourceRoot(configuredRoot, Environment.CurrentDirectory)
            }
            let location = typeof(GsharpTestProjectRunner).Assembly.Location
            return FindRepoRootAbove(Path.GetDirectoryName(location)) ??
                throw DirectoryNotFoundException(
                "Could not locate the repository source root above " +
                    "$location. Set " +
                    "$SourceRootEnvironmentVariable to the original source tree."
            )
        }

        // The repository root is the nearest ancestor holding nuget.config and the
        // solution (GSharp.sln, or GSharp.slnx after the cut-over); issue #4861.
        internal func FindRepoRootAbove(startDirectory string?) string? {
            var dir string? = startDirectory
            while !string.IsNullOrEmpty(dir) {
                if File.Exists(Path.Combine(dir, "nuget.config")) && RepositoryRootMarker.IsRoot(dir) {
                    return dir
                }
                dir = Path.GetDirectoryName(dir)
            }
            return nil
        }

        internal func ResolveConfiguredSourceRoot(configuredRoot string?, baseDirectory string) string? {
            let fullPath = Path.GetFullPath(configuredRoot!!, baseDirectory)
            let canonical string? = CanonicalRootPath.Resolve(fullPath)
            if !Directory.Exists(canonical) {
                throw DirectoryNotFoundException(
                    "Stage-4 source root from $SourceRootEnvironmentVariable does not exist: '$canonical'."
                )
            }
            return canonical
        }

        private func SplitVersion(version string)(Numbers[]int32, Suffix string) {
            if string.IsNullOrEmpty(version) {
                return (Array.Empty[int32](), string.Empty)
            }
            let dash = version.IndexOf('-')
            let release = if dash >= 0 {
                version.Substring(0, dash)
            } else {
                version
            }
            let suffix = if dash >= 0 {
                version.Substring(dash + 1)
            } else {
                string.Empty
            }
            let parts = release.Split('.')
            let numbers = [parts.Length]int32
            for var i = 0; i < parts.Length; i++ {
                numbers[i] = if int32.TryParse(parts[i], out var n) {
                    n
                } else {
                    0
                }
            }
            return (numbers, suffix)
        }

        private func ComparePrereleaseIdentifiers(left string, right string) int32 {
            let leftIds = left.Split('.')
            let rightIds = right.Split('.')
            let count = Math.Min(leftIds.Length, rightIds.Length)
            for var i = 0; i < count; i++ {
                let cmp = ComparePrereleaseIdentifier(leftIds[i], rightIds[i])
                if cmp != 0 {
                    return cmp
                }
            }
            // A larger set of identifiers outranks a smaller one when the shared
            // prefix is otherwise equal (SemVer §11.4.4).
            return leftIds.Length.CompareTo(rightIds.Length)
        }

        private func ComparePrereleaseIdentifier(left string, right string) int32 {
            let leftNumeric = IsNumericIdentifier(left, out var leftNum)
            let rightNumeric = IsNumericIdentifier(right, out var rightNum)
            if leftNumeric && rightNumeric {
                return leftNum.CompareTo(rightNum)
            }
            if leftNumeric != rightNumeric {
                // Numeric identifiers always have lower precedence than
                // alphanumeric identifiers (SemVer §11.4.3).
                return if leftNumeric {
                    -1
                } else {
                    1
                }
            }
            return string.CompareOrdinal(left, right)
        }

        private func IsNumericIdentifier(value string, out number int32) bool -> int32.TryParse(value, out number) &&
            value.Length > 0

        private func FilesAreIdentical(left string, right string) bool {
            let leftInfo = FileInfo(left)
            let rightInfo = FileInfo(right)
            if leftInfo.Length != rightInfo.Length {
                return false
            }
            return ComputeHash(left).SequenceEqual(ComputeHash(right))
        }

        private func ComputeHash(path string)[]uint8 {
            using let stream = File.OpenRead(path)
            using let sha256 = SHA256.Create()
            return sha256.ComputeHash(stream)
        }

        private func LibraryProject(project GsharpTestProject, sdkVersion string) string {
            let friendAssemblies = if project.LibraryFriendAssemblies.Count == 0 {
                string.Empty
            } else {
                `
  <ItemGroup>
` + string.Concat(
                    project.LibraryFriendAssemblies.Select(
                        (name string) -> "    <InternalsVisibleTo Include=\"" + SecurityElement.Escape(name) + "\" />\n"
                    )
                ) +
                    "  </ItemGroup>\n"
            }
            return (`<Project Sdk="` + "$SdkPackageId" + `/` + "$sdkVersion" + `">
`) + "\n" + "  <PropertyGroup>\n" + "    <OutputType>Library</OutputType>\n" + "    <TargetFramework>net10.0</TargetFramework>\n" + (
                `    <RootNamespace>` + "${project.LibraryRootNamespace}" + `</RootNamespace>
`
            ) + "  </PropertyGroup>\n" + friendAssemblies + "\n" + "</Project>\n"
        }

        private func TestsProject(project GsharpTestProject, sdkVersion string) string -> (
            `<Project Sdk="` + "$SdkPackageId" + `/` + "$sdkVersion" + `">
`
        ) +
            "\n" +
            "  <PropertyGroup>\n" +
            "    <OutputType>Library</OutputType>\n" +
            "    <TargetFramework>net10.0</TargetFramework>\n" +
            (`    <RootNamespace>` + "${project.TestsRootNamespace}" + `</RootNamespace>
`) +
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
            (`    <ProjectReference Include="..\` + "${project.LibraryName}" + `\` + "${project.LibraryName}" + `.gsproj" />
`) +
            "  </ItemGroup>\n" +
            "\n" +
            "</Project>\n"
    }
}

/// One G# source file (name + text) contributed to a generated test project.
class GsharpSourceFile {
    /// Initializes a new instance of the (cref:GsharpSourceFile) class.
    /// @param fileName The `.gs` file name.
    /// @param source The G# source text.
    init(fileName string?, source string) {
        this.FileName = fileName ?? throw ArgumentNullException("fileName")
        this.Source = source ?? string.Empty
    }

    /// Gets the `.gs` file name.
    prop FileName string {
        get;
    }

    /// Gets the G# source text.
    prop Source string {
        get;
    }
}

/// A translated G# library + xUnit test project to build and run for stage-4
/// library parity (ADR-0115 §C/§E).
class GsharpTestProject {
    /// Gets or sets the library project name (folder + assembly).
    private var _libraryName string = "Library"

    prop LibraryName string {
        get {
            return _libraryName
        }
        set {
            _libraryName = value
        }
    }

    /// Gets or sets the library root namespace.
    private var _libraryRootNamespace string = "Library"

    prop LibraryRootNamespace string {
        get {
            return _libraryRootNamespace
        }
        set {
            _libraryRootNamespace = value
        }
    }

    /// Gets or sets the translated G# library source files.
    private var _libraryFiles IReadOnlyList[GsharpSourceFile] = Array.Empty[GsharpSourceFile]()

    prop LibraryFiles IReadOnlyList[GsharpSourceFile] {
        get {
            return _libraryFiles
        }
        set {
            _libraryFiles = value
        }
    }

    /// Gets or sets friend assemblies declared by the source library project.
    private var _libraryFriendAssemblies IReadOnlyList[string] = Array.Empty[string]()

    prop LibraryFriendAssemblies IReadOnlyList[string] {
        get {
            return _libraryFriendAssemblies
        }
        set {
            _libraryFriendAssemblies = value
        }
    }

    /// Gets or sets the test project name (folder + assembly).
    private var _testsName string = "Library.Tests"

    prop TestsName string {
        get {
            return _testsName
        }
        set {
            _testsName = value
        }
    }

    /// Gets or sets the test root namespace.
    private var _testsRootNamespace string = "Library.Tests"

    prop TestsRootNamespace string {
        get {
            return _testsRootNamespace
        }
        set {
            _testsRootNamespace = value
        }
    }

    /// Gets or sets the translated G# xUnit test source files.
    private var _testFiles IReadOnlyList[GsharpSourceFile] = Array.Empty[GsharpSourceFile]()

    prop TestFiles IReadOnlyList[GsharpSourceFile] {
        get {
            return _testFiles
        }
        set {
            _testFiles = value
        }
    }

    /// Gets or sets the explicit `Gsharp.NET.Sdk` version to pin; when
    /// `null` the highest locally-built nupkg is used.
    prop SdkVersion string?
}

/// The outcome of a (cref:GsharpTestProjectRunner.Run) invocation.
class GsharpTestRunResult {
    private init(
        status GsharpTestRunStatus,
        exitCode int32,
        output string?,
        trxPath string?,
        results IReadOnlyList[TestCaseOutcome]?,
        unavailableReason string?
    ) {
        this.Status = status
        this.ExitCode = exitCode
        this.Output = output ?? string.Empty
        this.TrxPath = trxPath
        this.Results = results ?? Array.Empty[TestCaseOutcome]()
        this.UnavailableReason = unavailableReason
    }

    /// Gets the run status.
    prop Status GsharpTestRunStatus {
        get;
    }

    /// Gets the `dotnet test` exit code.
    prop ExitCode int32 {
        get;
    }

    /// Gets the combined stdout+stderr.
    prop Output string {
        get;
    }

    /// Gets the produced TRX path, or null when none was produced.
    prop TrxPath string? {
        get;
    }

    /// Gets the parsed per-test outcomes (empty unless the run produced a TRX).
    prop Results IReadOnlyList[TestCaseOutcome] {
        get;
    }

    /// Gets the reason the run could not be attempted, when unavailable.
    prop UnavailableReason string? {
        get;
    }

    /// Gets a value indicating whether `dotnet test` produced a parseable TRX.
    prop ProducedResults bool -> this.Status == GsharpTestRunStatus.Ran

    shared {
        /// Creates an unavailable result (no local SDK to build against).
        /// @param reason The reason the run could not be attempted.
        /// @returns An unavailable (cref:GsharpTestRunResult).
        func Unavailable(reason string) GsharpTestRunResult -> GsharpTestRunResult(
            GsharpTestRunStatus.Unavailable,
            0,
            nil,
            nil,
            nil,
            reason
        )

        /// Creates a build-failed result (no TRX was produced).
        /// @param exitCode The `dotnet test` exit code.
        /// @param output The combined output.
        /// @returns A build-failed (cref:GsharpTestRunResult).
        func BuildFailed(exitCode int32, output string) GsharpTestRunResult -> GsharpTestRunResult(
            GsharpTestRunStatus.BuildFailed,
            exitCode,
            output,
            nil,
            nil,
            nil
        )

        /// Creates a ran result carrying the parsed outcomes.
        /// @param exitCode The `dotnet test` exit code.
        /// @param output The combined output.
        /// @param trxPath The produced TRX path.
        /// @param results The parsed per-test outcomes.
        /// @returns A ran (cref:GsharpTestRunResult).
        func Ran(
            exitCode int32,
            output string,
            trxPath string,
            results IReadOnlyList[TestCaseOutcome]
        ) GsharpTestRunResult -> GsharpTestRunResult(GsharpTestRunStatus.Ran, exitCode, output, trxPath, results, nil)
    }
}
