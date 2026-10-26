// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit

/// Checks source version metadata through the migration driver.
class Issue5402SourceVersionTests : IDisposable {
    private let root string = Path.Combine(AppContext.BaseDirectory, "source-version-" + Guid.NewGuid().ToString("N"))
    private let previousCeiling string? = Environment.GetEnvironmentVariable("GIT_CEILING_DIRECTORIES")
    private let previousGlobalConfig string? = Environment.GetEnvironmentVariable("GIT_CONFIG_GLOBAL")

    init() {
        Directory.CreateDirectory(this.root)
        let globalConfig = Path.Combine(this.root, "global.gitconfig")
        File.WriteAllText(globalConfig, "[clone]\n    defaultRemoteName = source-copy\n")
        Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", globalConfig)
        Environment.SetEnvironmentVariable("GIT_CEILING_DIRECTORIES", this.root)
        Git(this.root, "init", "--quiet")
    }

    func Dispose() {
        Environment.SetEnvironmentVariable("GIT_CEILING_DIRECTORIES", this.previousCeiling)
        Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", this.previousGlobalConfig)
        for file in Directory.EnumerateFiles(this.root, "*", SearchOption.AllDirectories) {
            File.SetAttributes(file, FileAttributes.Normal)
        }
        Directory.Delete(this.root, recursive: true)
    }

    @Theory
    @InlineData("repository")
    @InlineData("worktree")
    @InlineData("archive")
    async func Migrate_PreservesVersionOutputBytesInsideAnotherRepository(kind string) {
        let source = Path.Combine(this.root, "source")
        Directory.CreateDirectory(source)
        GsharpTestProjectRunner.WriteIsolationBoundary(source)
        File.WriteAllText(Path.Combine(source, "VersionProbe.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Nerdbank.GitVersioning" Version="3.11.13-beta" PrivateAssets="all" />
  </ItemGroup>
</Project>`)
        File.WriteAllText(
            Path.Combine(source, "Program.cs"),
            "System.Console.WriteLine(ThisAssembly.AssemblyInformationalVersion);"
        )
        File.WriteAllText(Path.Combine(source, "version.json"), "{\"version\":\"2.3\"}")
        let hasHistory = kind != "archive"
        let sourceRemote = if kind == "repository" {
            "origin"
        } else {
            "upstream"
        }
        if hasHistory {
            Git(source, "init", "--quiet")
            Git(source, "remote", "add", sourceRemote, "https://example.invalid/source-version.git")
            Git(source, "config", "remote.publish.pushurl", "https://example.invalid/publish-version.git")
            Commit(source)
            Git(source, "branch", "version-baseline")
            Git(source, "update-ref", "refs/remotes/origin/version-baseline", "HEAD")
            File.WriteAllText(Path.Combine(source, "history.txt"), "version height must include this commit")
            Commit(source)
            Git(source, "checkout", "--quiet", "-b", "feature/source-version")
        }
        let sourceHead = if hasHistory {
            Git(
                source,
                "rev-parse",
                if kind == "worktree" {
                    "HEAD^"
                } else {
                    "HEAD"
                }
            ).Trim()
        } else {
            string.Empty
        }
        let checkout = if kind == "worktree" {
            Path.Combine(this.root, "checkout")
        } else {
            source
        }
        if kind == "worktree" {
            Git(source, "worktree", "add", "--quiet", "--detach", checkout, sourceHead)
            Assert.True(File.Exists(Path.Combine(checkout, ".git")))
        }
        Run("dotnet", checkout, "build", "VersionProbe.csproj", "-c", "Release", "-graph")
        let original = Run(
            "dotnet",
            checkout,
            Path.Combine(checkout, "bin", "Release", "net10.0", "VersionProbe.dll"),
            "--version"
        )
        if hasHistory {
            Assert.Contains(sourceHead.Substring(0, 10), original)
        }
        let host = this.CreateHost()
        let mirror = Path.Combine(host, "mirror")
        let artifacts = Path.Combine(this.root, "runs")
        let repo = GsharpTestProjectRunner.FindRepoRoot()!!
        let compiler = Path.Combine(repo, "out", "bin", "Release", "Compiler", "gsc.dll")
        Assert.True(File.Exists(compiler), "Build the compiler before this driver test.")
        Assert.NotNull(GsharpTestProjectRunner.ResolveLocalSdkPackage(repo))
        let exit = await Program.Main(
            []string{
                "migrate",
                "--corpus",
                checkout,
                "--out",
                mirror,
                "--artifacts",
                artifacts,
                "--gsc",
                compiler,
                "--config",
                "Release",
                "--stop-after",
                "compile"
            }
        )
        Assert.Equal(0, exit)
        let run = Directory.GetFiles(artifacts, "run.json", SearchOption.AllDirectories).Single()
        let appArtifacts = Path.Combine(
            Path.GetDirectoryName(run)!!,
            MigrationPipeline.ArtifactDirectoryName("VersionProbe.csproj", MigrationOutputLayout.Repository)
        )
        let runtimeConfig = Directory.GetFiles(
            Path.Combine(appArtifacts, "bin"),
            "VersionProbe.runtimeconfig.json",
            SearchOption.AllDirectories
        )
            .Single()
        let assembly = Path.Combine(Path.GetDirectoryName(runtimeConfig)!!, "VersionProbe.dll")
        let migrated = Run("dotnet", mirror, assembly, "--version")
        let expected = Encoding.UTF8.GetBytes(original)
        Assert.NotEmpty(expected)
        Assert.Equal(expected, Encoding.UTF8.GetBytes(migrated))
        if hasHistory {
            Assert.Equal(sourceHead, Git(mirror, "rev-parse", "HEAD").Trim())
            let sourceRefs = GitRefs(checkout)
            Assert.NotEmpty(sourceRefs)
            Assert.Equal(sourceRefs, GitRefs(mirror))
            Assert.Equal(
                Git(checkout, "remote", "get-url", sourceRemote),
                Git(mirror, "remote", "get-url", sourceRemote)
            )
            Assert.Equal(
                Git(checkout, "remote", "get-url", "--push", "publish"),
                Git(mirror, "remote", "get-url", "--push", "publish")
            )
            Assert.Equal(
                1,
                ProcessRunner.Run("git", []string{"config", "--get-all", "remote.publish.url"}, mirror).ExitCode
            )
        }
        let secondMirror = Path.Combine(host, "second-mirror")
        RepositoryMirror.Prepare(checkout, secondMirror)
        if hasHistory {
            Assert.Equal(sourceHead, Git(secondMirror, "rev-parse", "HEAD").Trim())
            Assert.Equal(GitRefs(checkout), GitRefs(secondMirror))
        }
        Assert.Equal(
            File.ReadAllBytes(Path.Combine(checkout, "version.json")),
            File.ReadAllBytes(Path.Combine(secondMirror, "version.json"))
        )
    }

    @Fact
    func Prepare_ArchiveDoesNotInheritDestinationHistory() {
        let archive = Path.Combine(this.root, "archive")
        Directory.CreateDirectory(archive)
        File.WriteAllText(Path.Combine(archive, "version.json"), "{\"version\":\"2.3\"}")
        let host = this.CreateHost()
        let mirror = Path.Combine(host, "archive-mirror")
        RepositoryMirror.Prepare(archive, mirror)
        let result = ProcessRunner.Run("git", []string{"rev-parse", "--verify", "HEAD"}, mirror)
        Assert.NotEqual(0, result.ExitCode)
        Assert.Equal(Path.GetFullPath(mirror), Path.GetFullPath(Git(mirror, "rev-parse", "--show-toplevel").Trim()))
    }

    @Fact
    func Prepare_InvalidGitRootDoesNotBecomeAnArchive() {
        let source = Path.Combine(this.root, "broken-source")
        Directory.CreateDirectory(source)
        File.WriteAllText(Path.Combine(source, ".git"), "gitdir: missing-git-directory")
        let mirror = Path.Combine(this.root, "broken-mirror")
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return RepositoryMirror.Prepare(source, mirror)
            }
        )
        Assert.Contains("Cannot read source Git metadata", error.Message)
        Assert.False(Directory.Exists(mirror))
    }

    @Fact
    func Prepare_TrackedSubdirectoryCannotUseTheWrongHistoryPaths() {
        let host = this.CreateHost()
        let subdirectory = Path.Combine(host, "component")
        Directory.CreateDirectory(subdirectory)
        File.WriteAllText(Path.Combine(subdirectory, "version.json"), "{\"version\":\"2.3\"}")
        Commit(host)
        let mirror = Path.Combine(this.root, "partial-mirror")
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return RepositoryMirror.Prepare(subdirectory, mirror)
            }
        )
        Assert.Contains("Git working-tree root", error.Message)
        Assert.False(Directory.Exists(mirror))
    }

    private func CreateHost() string {
        let host = Path.Combine(this.root, "host")
        Directory.CreateDirectory(host)
        File.WriteAllText(Path.Combine(host, "version.json"), "{\"version\":\"9.8\"}")
        Git(host, "init", "--quiet")
        Commit(host)
        return host
    }

    shared {
        private func Commit(directory string) {
            Git(directory, "add", ".")
            Git(
                directory,
                "-c",
                "user.name=Version Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Version fixture"
            )
        }

        private func Git(directory string, arguments ...string) string -> Run("git", directory, arguments)

        private func GitRefs(directory string)[]byte -> Encoding.UTF8.GetBytes(
            Git(directory, "for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)")
        )

        private func Run(file string, directory string, arguments ...string) string {
            let result = ProcessRunner.Run(file, arguments, directory, TimeSpan.FromMinutes(5))
            Assert.True(result.ExitCode == 0, result.Output)
            Assert.False(result.TimedOut)
            return result.Stdout
        }
    }
}
