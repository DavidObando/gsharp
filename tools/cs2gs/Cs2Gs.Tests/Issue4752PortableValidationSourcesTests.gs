// <copyright file="Issue4752PortableValidationSourcesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import Xunit

/// Artifact replay must retain original source identity, ownership and the existing Fact budget.
class Issue4752PortableValidationSourcesTests : IDisposable {
    private let root string = Path.Combine(
        CanonicalRootPath.Resolve(Path.GetTempPath())!!,
        "cs2gs-4752-" + Guid.NewGuid().ToString("N")
    )

    @Theory
    @InlineData(false)
    @InlineData(true)
    async func Validate_RelocatedSourcesMatchNonrelocatedCountAndBudget(legacy bool) {
        let fixture = this.CreateFixture(legacy)
        let control Observation? = await this.Validate(fixture, fixture.Source)
        Assert.Equal(403, control!!.Facts)
        Assert.Equal(TimeSpan.FromMinutes(16), control!!.Budget)
        let relocated = Path.Combine(this.root, "relocated")
        Directory.Move(fixture.Source, relocated)
        let replay Observation? = await this.Validate(fixture, relocated)
        Assert.Equal(control!!.Facts, replay!!.Facts)
        Assert.Equal(control!!.Budget, replay!!.Budget)
        Assert.Equal(5, replay!!.Files.Count)
        Assert.Equal(1, replay!!.Files.Count((file EmittedGsFile) -> file.IsFromReferencedProject))
        Assert.Equal(
            2,
            replay!!.Files.Count(
                (file EmittedGsFile) -> file.CsFilePath == Path.Combine(relocated, "test", "Shared", "Linked.cs")
            )
        )
        Assert.Contains(
            replay!!.Files,
            (file EmittedGsFile) -> file.CsFilePath == Path.Combine(relocated, "test", "Own", "Strings.resx")
        )
        Assert.All(
            replay!!.Files,
            (file EmittedGsFile) -> Assert.StartsWith(relocated + Path.DirectorySeparatorChar, file.CsFilePath)
        )
        Assert.Equal(fixture.ManifestBytes, File.ReadAllBytes(fixture.ManifestPath))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    async func Validate_UsesAuthorizedCorpusEvenWhenProducingPathStillExists(legacy bool) {
        let fixture = this.CreateFixture(legacy)
        let relocated = Path.Combine(this.root, "relocated")
        Directory.Move(fixture.Source, relocated)
        Write(Path.Combine(fixture.Source, "test", "Own", "Tests.cs"), Facts(1))
        Write(Path.Combine(fixture.Source, "test", "Shared", "Linked.cs"), Facts(1))
        let replay Observation? = await this.Validate(fixture, relocated)
        Assert.Equal(403, replay!!.Facts)
        Assert.Equal(TimeSpan.FromMinutes(16), replay!!.Budget)
    }

    @Theory
    @InlineData(false, "test/Shared/Linked.cs")
    @InlineData(true, "test/Shared/Linked.cs")
    @InlineData(false, "test/Own/Tests.cs")
    @InlineData(true, "test/Own/Tests.cs")
    async func Validate_MissingAuthoritativeSourceFailsBeforeStages(legacy bool, missing string) {
        let fixture = this.CreateFixture(legacy)
        File.Delete(Path.Combine(fixture.Source, missing))
        let probe = SourceEvidenceStage()
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.Contains("missing from authoritative corpus", error.Message, StringComparison.Ordinal)
        Assert.Null(probe.Observation)
    }

    @Theory
    @InlineData("app")
    @InlineData("project")
    @InlineData("identity")
    @InlineData("source-escape")
    @InlineData("migrated-escape")
    @InlineData("absolute")
    @InlineData("incomplete")
    @InlineData("producing-escape")
    @InlineData("empty-source")
    @InlineData("empty-identity")
    async func Validate_InvalidManifestIdentityFailsBeforeStages(invalid string) {
        let fixture = this.CreateFixture(legacy: false)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        switch invalid {
            case "app" {
                manifest.AppId = "src/Unrelated/Unrelated.csproj"
            }
            case "project" {
                manifest.SourceProjectPath = "src/Lib/Lib.csproj"
            }
            case "identity" {
                manifest.EmittedFiles[0].RelativeCsPath = "test/Shared/Linked.cs"
            }
            case "source-escape" {
                manifest.EmittedFiles[0].CsFilePath = manifest.SourceRoot + "/../outside.cs"
                manifest.EmittedFiles[0].RelativeCsPath = "../outside.cs"
            }
            case "migrated-escape" {
                manifest.EmittedFiles[0].Path = "../outside.gs"
            }
            case "absolute" {
                manifest.EmittedFiles[0].Path = Path.Combine(this.root, "outside.gs")
            }
            case "incomplete" {
                manifest.SourceRoot = nil
            }
            case "producing-escape" {
                manifest.SourceRoot += "/.."
                for file in manifest.EmittedFiles {
                    file.CsFilePath = manifest.SourceRoot + "/" + file.RelativeCsPath
                }
            }
            case "empty-source" {
                manifest.EmittedFiles[0].CsFilePath = nil
            }
            case "empty-identity" {
                manifest.EmittedFiles[0].CsFilePath = nil
                manifest.EmittedFiles[0].RelativeCsPath = nil
            }
        }
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let probe = SourceEvidenceStage()
        await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.Null(probe.Observation)
    }

    @Theory
    @InlineData("", false)
    @InlineData("", true)
    @InlineData(" \t\r\n", false)
    @InlineData(" \t\r\n", true)
    async func Validate_BlankModernSourceRootFailsBeforeHydration(producingRoot string, empty bool) {
        let fixture = this.CreateFixture(legacy: false)
        let control Observation? = await this.Validate(fixture, fixture.Source)
        Assert.Equal(403, control!!.Facts)
        Assert.Equal(TimeSpan.FromMinutes(16), control!!.Budget)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        manifest.SourceRoot = producingRoot
        manifest.RootNamespace = "MustNotHydrate"
        manifest.GeneratedFriendAssemblies.Add("MustNotHydrate")
        if empty {
            manifest.EmittedFiles.Clear()
        }
        Console.WriteLine("blank modern source identity: " + JsonSerializer.Serialize(manifest))
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let probe = SourceEvidenceStage()
        let driverError = await Record.ExceptionAsync(
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        let app = RepositoryDiscovery.Discover(fixture.Source).Single((app CorpusApp) -> app.Id == fixture.AppId)
        let context = StageExecutionContext(
            app,
            PipelineOptions{SourceRoot: fixture.Source},
            GscInvoker(Compiler()!!),
            fixture.Migrated,
            TriageBuilder("hydrate", "ts", "gsc", app.Id)
        )
        context.RootNamespace = "BeforeHydration"
        let hydrationError = Record.Exception(() -> manifest.Hydrate(context, fixture.Migrated))!!
        Assert.True(
            driverError is InvalidOperationException,
            "Blank modern root replay reached validation with ${probe.Observation?.Files.Count} files, " +
                "${probe.Observation?.Facts} Facts and ${probe.Observation?.Budget} budget."
        )
        Assert.Contains("non-empty producing corpus source root", driverError.Message, StringComparison.Ordinal)
        Assert.IsType[InvalidOperationException](hydrationError)
        Assert.Contains("non-empty producing corpus source root", hydrationError.Message, StringComparison.Ordinal)
        Assert.False(context.IsTestProject)
        Assert.Equal("BeforeHydration", context.RootNamespace)
        Assert.Empty(context.GeneratedFriendAssemblies)
        Assert.Empty(context.EmittedFiles)
        Assert.Null(probe.Observation)
    }

    @Theory
    @InlineData("empty")
    @InlineData("no-inputs")
    @InlineData("referenced-only")
    async func Validate_ModernProjectIdentitySupportsSourceSetsWithoutOwnAnchor(sourceSet string) {
        let fixture = this.CreateFixture(legacy: false, rootProject: true)
        let original = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(original)
        if sourceSet == "no-inputs" {
            File.Delete(Path.Combine(fixture.Source, "Program.cs"))
            File.Delete(Path.Combine(fixture.Source, "Strings.resx"))
        }
        let app = RepositoryDiscovery.Discover(fixture.Source).Single((app CorpusApp) -> app.Id == fixture.AppId)
        let capture = StageExecutionContext(
            app,
            PipelineOptions{SourceRoot: fixture.Source},
            GscInvoker(Compiler()!!),
            fixture.Migrated,
            TriageBuilder("capture", "ts", "gsc", app.Id)
        )
        capture.IsTestProject = true
        if sourceSet == "referenced-only" {
            let file = Assert.Single(original.EmittedFiles, (file ValidationManifestFile) -> file.FromReferencedProject)
            capture.EmittedFiles.Add(
                EmittedGsFile(
                    Path.Combine(fixture.Migrated, file.Path),
                    file.RelativeGsPath,
                    file.CsFilePath,
                    "package Fixture\n"
                ){IsFromReferencedProject = true}
            )
        }
        ValidationManifest.Write(
            ValidationManifest.Capture(capture, translated: true, fixture.Migrated),
            Path.GetDirectoryName(fixture.ManifestPath)
        )
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        Console.WriteLine(sourceSet + " captured modern source identity: " + JsonSerializer.Serialize(manifest))
        let replay Observation? = await this.Validate(fixture, fixture.Source)
        let hydrated = StageExecutionContext(
            app,
            capture.Options,
            capture.Gsc,
            fixture.Migrated,
            TriageBuilder("hydrate", "ts", "gsc", app.Id)
        )
        manifest.Hydrate(hydrated, fixture.Migrated)
        Assert.Equal(fixture.Source, manifest.SourceRoot)
        Assert.Equal("Own.csproj", manifest.SourceProjectPath)
        Assert.Equal(
            if sourceSet == "referenced-only" {
                1
            } else {
                0
            },
            replay!!.Files.Count
        )
        Assert.Equal(replay!!.Files.Count, hydrated.EmittedFiles.Count)
        Assert.True(hydrated.IsTestProject)
        Assert.Equal(0, replay!!.Facts)
        Assert.Equal(TimeSpan.FromMinutes(10), replay!!.Budget)
        Assert.Equal(replay!!.Facts, TestParityStage.CountCSharpFactMethods(hydrated))
        Assert.Equal(replay!!.Budget, SdkCompileRunner.MirroredTestRunTimeoutFor(replay!!.Facts))
        if sourceSet == "referenced-only" {
            let file = Assert.Single(replay!!.Files)
            Assert.True(file.IsFromReferencedProject)
            Assert.Equal(Path.Combine(fixture.Source, "src", "Lib", "Tests.cs"), file.CsFilePath)
            Assert.Contains("Case899", File.ReadAllText(file.CsFilePath!!), StringComparison.Ordinal)
        }
        manifest.SourceRoot = nil
        manifest.SourceProjectPath = nil
        for file in manifest.EmittedFiles {
            file.RelativeCsPath = nil
        }
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let probe = SourceEvidenceStage()
        let legacyError = await Record.ExceptionAsync(
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.True(
            legacyError is InvalidOperationException,
            "Legacy $sourceSet replay reached validation with ${probe.Observation?.Files.Count} files, " +
                "${probe.Observation?.Facts} Facts and ${probe.Observation?.Budget} budget."
        )
        Assert.Contains("unambiguous owning corpus source root", legacyError.Message, StringComparison.Ordinal)
        Assert.Null(probe.Observation)
    }

    @Theory
    @InlineData(false, true)
    @InlineData(true, true)
    @InlineData(false, false)
    @InlineData(true, false)
    async func Validate_SymlinkSpelledCorpusPreservesCapturedProjectOwnership(legacy bool, rootProject bool) {
        let fixture = this.CreateFixture(legacy: false, rootProject)
        let control Observation? = await this.Validate(fixture, fixture.Source)
        Assert.Equal(
            if rootProject {
                400
            } else {
                403
            },
            control!!.Facts
        )
        Assert.Equal(
            TimeSpan.FromMinutes(
                if rootProject {
                    15
                } else {
                    16
                }
            ),
            control!!.Budget
        )
        let alias = Path.Combine(this.root, "source-alias")
        Directory.CreateSymbolicLink(alias, fixture.Source)
        let app = RepositoryDiscovery.Discover(alias).Single((app CorpusApp) -> app.Id == fixture.AppId)
        Assert.StartsWith(alias + Path.DirectorySeparatorChar, app.ProjectPath)
        let capture = StageExecutionContext(
            app,
            PipelineOptions{SourceRoot: alias},
            GscInvoker(Compiler()!!),
            fixture.Migrated,
            TriageBuilder("capture", "ts", "gsc", app.Id)
        )
        capture.IsTestProject = true
        let original = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(original)
        for file in original.EmittedFiles {
            capture.EmittedFiles.Add(
                EmittedGsFile(
                    Path.Combine(fixture.Migrated, file.Path),
                    file.RelativeGsPath,
                    Path.Combine(alias, Path.GetRelativePath(fixture.Source, file.CsFilePath!!)),
                    "package Fixture\n"
                ){IsFromReferencedProject = file.FromReferencedProject}
            )
        }
        let manifest = ValidationManifest.Capture(capture, translated: true, fixture.Migrated)
        Console.WriteLine("symlink corpus captured source identity: " + JsonSerializer.Serialize(manifest))
        if legacy {
            manifest.SourceRoot = nil
            manifest.SourceProjectPath = nil
            for file in manifest.EmittedFiles {
                file.RelativeCsPath = nil
            }
        }
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let replay Observation? = await this.Validate(fixture, alias)
        Assert.Equal(control!!.Facts, replay!!.Facts)
        Assert.Equal(control!!.Budget, replay!!.Budget)
        Assert.Equal(
            if rootProject {
                3
            } else {
                5
            },
            replay!!.Files.Count
        )
        Assert.Single(replay!!.Files, (file EmittedGsFile) -> file.IsFromReferencedProject)
        Assert.All(
            replay!!.Files,
            (file EmittedGsFile) -> Assert.StartsWith(fixture.Source + Path.DirectorySeparatorChar, file.CsFilePath)
        )
        if !rootProject {
            Assert.Equal(
                2,
                replay!!.Files.Count(
                    (file EmittedGsFile) -> file.CsFilePath == Path.Combine(
                        fixture.Source,
                        "test",
                        "Shared",
                        "Linked.cs"
                    )
                )
            )
        }
        if !legacy {
            Assert.Equal(fixture.Source, manifest.SourceRoot)
            Assert.Equal(fixture.AppId, manifest.SourceProjectPath)
        }
    }

    @Fact
    async func Validate_LegacyConflictingRootsAreNotSelectedByFileExistence() {
        let fixture = this.CreateFixture(legacy: true)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        manifest.EmittedFiles[2].CsFilePath = Path.Combine(this.root, "unrelated", "src", "Lib", "Tests.cs")
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let probe = SourceEvidenceStage()
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.Contains("unambiguous owning corpus source root", error.Message, StringComparison.Ordinal)
        Assert.Null(probe.Observation)
    }

    @Fact
    async func Validate_LegacyEmptyManifestFailsBeforeStages() {
        let fixture = this.CreateFixture(legacy: true)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        manifest.EmittedFiles.Clear()
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let probe = SourceEvidenceStage()
        let error = await Record.ExceptionAsync(
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.True(
            error is InvalidOperationException,
            "Legacy replay reached validation with ${probe.Observation?.Files.Count} files, " +
                "${probe.Observation?.Facts} Facts and ${probe.Observation?.Budget} budget."
        )
        Assert.Contains("unambiguous owning corpus source root", error.Message, StringComparison.Ordinal)
        Assert.Null(probe.Observation)
    }

    @Fact
    async func Validate_LegacyReferencedSourcesCannotEstablishAppOwnership() {
        let fixture = this.CreateFixture(legacy: true)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        manifest.EmittedFiles.RemoveAll((file ValidationManifestFile) -> !file.FromReferencedProject)
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let probe = SourceEvidenceStage()
        await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.Null(probe.Observation)
    }

    @Fact
    async func Validate_LegacyRootProjectDefaultCompileMatchesCapturedModernReplay() {
        let fixture = this.CreateFixture(legacy: false, rootProject: true)
        let apps = RepositoryDiscovery.Discover(fixture.Source)
        let app = apps.Single((app CorpusApp) -> app.Id == "Own.csproj")
        Assert.Equal(fixture.Source, Path.GetDirectoryName(app.ProjectPath))
        let excluded = RepositoryExcludedScope.Compute(fixture.Source, []string{app.ProjectPath})
        Assert.False(excluded.IsExcluded("Program.cs"))
        Assert.False(excluded.IsExcluded("src/Lib/Tests.cs"))
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        Assert.Equal("Own.csproj", manifest.SourceProjectPath)
        Assert.Equal("Program.cs", manifest.EmittedFiles[0].RelativeCsPath)
        let control Observation? = await this.Validate(fixture, fixture.Source)
        Assert.Equal(400, control!!.Facts)
        Assert.Equal(TimeSpan.FromMinutes(15), control!!.Budget)
        manifest.SourceRoot = nil
        manifest.SourceProjectPath = nil
        for file in manifest.EmittedFiles {
            file.RelativeCsPath = nil
        }
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let relocated = Path.Combine(this.root, "relocated")
        Directory.Move(fixture.Source, relocated)
        let replay Observation? = await this.Validate(fixture, relocated)
        Assert.Equal(control!!.Facts, replay!!.Facts)
        Assert.Equal(control!!.Budget, replay!!.Budget)
        Assert.Equal(3, replay!!.Files.Count)
        Assert.Single(replay!!.Files, (file EmittedGsFile) -> file.IsFromReferencedProject)
        Assert.Contains(
            replay!!.Files,
            (file EmittedGsFile) -> file.CsFilePath == Path.Combine(relocated, "Program.cs")
        )
        Assert.Contains(
            replay!!.Files,
            (file EmittedGsFile) -> file.CsFilePath == Path.Combine(relocated, "Strings.resx")
        )
        Assert.All(
            replay!!.Files,
            (file EmittedGsFile) -> Assert.StartsWith(relocated + Path.DirectorySeparatorChar, file.CsFilePath)
        )
    }

    @Theory
    @InlineData("referenced-only")
    @InlineData("empty")
    @InlineData("resource-only")
    @InlineData("nested-project")
    async func Validate_LegacyRootProjectRequiresItsNonreferencedPrimaryAnchor(invalid string) {
        var fixture = this.CreateFixture(legacy: true, rootProject: true)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        switch invalid {
            case "referenced-only" {
                manifest.EmittedFiles.RemoveAll((file ValidationManifestFile) -> !file.FromReferencedProject)
            }
            case "empty" {
                manifest.EmittedFiles.Clear()
            }
            case "resource-only" {
                manifest.EmittedFiles.RemoveAll(
                    (file ValidationManifestFile) -> !file.CsFilePath!!.EndsWith(".resx", StringComparison.Ordinal)
                )
            }
            case "nested-project" {
                manifest.AppId = "src/Interop/Interop.csproj"
                fixture = fixture with{AppId = manifest.AppId}
            }
        }
        ValidationManifest.Write(
            manifest,
            Path.Combine(
                fixture.Manifests,
                MigrationPipeline.ArtifactDirectoryName(fixture.AppId, MigrationOutputLayout.Repository)
            )
        )
        let probe = SourceEvidenceStage()
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.Contains("unambiguous owning corpus source root", error.Message, StringComparison.Ordinal)
        Assert.Null(probe.Observation)
    }

    @Fact
    async func Validate_LegacyLinkedSourceCanEstablishItsDeclaringProjectOwnership() {
        let fixture = this.CreateFixture(legacy: true)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        manifest.EmittedFiles.RemoveAll(
            (file ValidationManifestFile) -> Path.GetRelativePath(fixture.Source, file.CsFilePath!!).Replace(
                '\\',
                '/'
            ) != "test/Shared/Linked.cs"
        )
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let relocated = Path.Combine(this.root, "relocated")
        Directory.Move(fixture.Source, relocated)
        let replay Observation? = await this.Validate(fixture, relocated)
        Assert.Equal(2, replay!!.Files.Count)
        Assert.Equal(3, replay!!.Facts)
        Assert.Equal(TimeSpan.FromMinutes(10), replay!!.Budget)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    async func Validate_SourceSymlinkCannotEscapeAuthorizedCorpus(legacy bool) {
        let fixture = this.CreateFixture(legacy)
        let source = Path.Combine(fixture.Source, "test", "Own", "Tests.cs")
        let outside = Path.Combine(this.root, "outside.cs")
        File.Move(source, outside)
        File.CreateSymbolicLink(source, outside)
        let probe = SourceEvidenceStage()
        await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return this.Validate(fixture, fixture.Source, probe)
            }
        )
        Assert.Null(probe.Observation)
    }

    @Theory
    @InlineData(false, "C:\\RUNNER\\GSHARP")
    @InlineData(true, "C:\\RUNNER\\GSHARP")
    @InlineData(false, "/")
    @InlineData(true, "/")
    @InlineData(false, "C:\\")
    @InlineData(true, "C:\\")
    @InlineData(false, "\\\\SERVER\\SHARE\\")
    @InlineData(true, "\\\\SERVER\\SHARE\\")
    async func Validate_PortablePathsAcceptProducerProvenance(legacy bool, producingRoot string) {
        let fixture = this.CreateFixture(legacy)
        let manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath))!!
        Assert.NotNull(manifest)
        if !legacy {
            manifest.SourceRoot = producingRoot
            manifest.SourceProjectPath = manifest.SourceProjectPath!!.Replace('/', '\\')
        }
        let prefix = producingRoot.TrimEnd('/', '\\') + "\\"
        var index = 0
        for file in manifest.EmittedFiles {
            let relative = Path.GetRelativePath(fixture.Source, file.CsFilePath!!).Replace('/', '\\')
            if !legacy {
                file.RelativeCsPath = relative
            }
            file.CsFilePath = (
                if index % 2 == 0 {
                    prefix.ToLowerInvariant()
                } else {
                    prefix
                }
            ) +
                relative
            index++
            file.Path = file.Path.Replace('/', '\\')
        }
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath))
        let replay Observation? = await this.Validate(fixture, fixture.Source)
        Assert.Equal(403, replay!!.Facts)
        Assert.Equal(TimeSpan.FromMinutes(16), replay!!.Budget)
    }

    func Dispose() {
        if Directory.Exists(this.root) {
            Directory.Delete(this.root, recursive: true)
        }
    }

    private func CreateFixture(legacy bool, rootProject bool = false) Issue4752PortableValidationSourcesTests.Fixture {
        let source = Path.Combine(this.root, "source")
        let migrated = Path.Combine(this.root, "migrated")
        let project = if rootProject {
            "Own.csproj"
        } else {
            "test/Own/Own.csproj"
        }
        let ownSource = if rootProject {
            "Program.cs"
        } else {
            "test/Own/Tests.cs"
        }
        let resource = if rootProject {
            "Strings.resx"
        } else {
            "test/Own/Strings.resx"
        }
        Write(
            Path.Combine(source, project),
            if rootProject {
                `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <Compile Remove="src/**/*.cs" />
    <ProjectReference Include="src/Lib/Lib.csproj" />
    <ProjectReference Include="src/Interop/Interop.csproj" ReferenceOutputAssembly="false" />
  </ItemGroup>
</Project>`
            } else {
                `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <Compile Include="../Shared/Linked.cs" Link="Linked.cs" />
    <ProjectReference Include="../../src/Lib/Lib.csproj" />
    <ProjectReference Include="../../src/Interop/Interop.csproj" ReferenceOutputAssembly="false" />
  </ItemGroup>
</Project>`
            }
        )
        Write(
            Path.Combine(source, "src", "Lib", "Lib.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        Write(
            Path.Combine(source, "src", "Interop", "Interop.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        Write(Path.Combine(source, ownSource), Facts(400))
        if !rootProject {
            Write(Path.Combine(source, "test", "Shared", "Linked.cs"), Facts(3))
        }
        Write(Path.Combine(source, "src", "Lib", "Tests.cs"), Facts(900))
        Write(Path.Combine(source, resource), "<root />")
        let app = RepositoryDiscovery.Discover(source).Single((app CorpusApp) -> app.Id == project)
        let context = StageExecutionContext(
            app,
            PipelineOptions{SourceRoot: source},
            GscInvoker(Compiler()!!),
            migrated,
            TriageBuilder("capture", "ts", "gsc", app.Id)
        )
        let Add = func (gs string, cs string, referenced bool) {
            let gsPath = Path.Combine(migrated, gs)
            Write(gsPath, "package Fixture\n")
            context.EmittedFiles.Add(
                EmittedGsFile(gsPath, gs, Path.Combine(source, cs), "package Fixture\n"){
                    IsFromReferencedProject = referenced
                }
            )
        }
        context.IsTestProject = true
        Add(Path.ChangeExtension(ownSource, ".gs"), ownSource, referenced: false)
        if !rootProject {
            Add("test/Shared/Linked.gs", "test/Shared/Linked.cs", referenced: false)
        }
        Add("src/Lib/Tests.gs", "src/Lib/Tests.cs", referenced: true)
        if !rootProject {
            Add("test/Shared/Linked.Second.gs", "test/Shared/Linked.cs", referenced: false)
        }
        Add(Path.ChangeExtension(resource, ".Designer.gs"), resource, referenced: false)
        let manifests = Path.Combine(this.root, "manifests")
        let artifact = Path.Combine(
            manifests,
            MigrationPipeline.ArtifactDirectoryName(app.Id, MigrationOutputLayout.Repository)
        )
        let manifest = ValidationManifest.Capture(context, translated: true, migrated)
        if legacy {
            manifest.SourceRoot = nil
            manifest.SourceProjectPath = nil
            for file in manifest.EmittedFiles {
                file.RelativeCsPath = nil
            }
        }
        ValidationManifest.Write(manifest, artifact)
        let manifestPath = Path.Combine(artifact, ValidationManifest.FileName)
        return Issue4752PortableValidationSourcesTests.Fixture(
            source,
            migrated,
            manifests,
            manifestPath,
            File.ReadAllBytes(manifestPath),
            app.Id
        )
    }

    private async func Validate(
        fixture Issue4752PortableValidationSourcesTests.Fixture,
        source string,
        probe SourceEvidenceStage? = nil
    ) Observation? {
        var probe = probe
        let apps = RepositoryDiscovery.Discover(source)
        let app = apps.Single((app CorpusApp) -> app.Id == fixture.AppId)
        probe ??= SourceEvidenceStage()
        let options = PipelineOptions{
            SourceRoot: source,
            OutputRoot: fixture.Migrated,
            ArtifactRoot: Path.Combine(this.root, "observations"),
            GscPath: Compiler()
        }
        options.PassthroughProjectPaths.Add(Path.Combine(source, "src", "Interop", "Interop.csproj"))
        let result = await MigrationPipeline(options, []IMigrationStage{probe!!}).ValidateAsync(
            apps,
            []CorpusApp{app},
            fixture.Manifests
        )
        Assert.True(result.Succeeded)
        Assert.True(result.Unverified)
        Assert.Equal("skipped", Assert.Single(Assert.Single(result.Apps).Stages).Status)
        Assert.Equal(
            Path.Combine(fixture.Migrated, "src", "Interop", "Interop.csproj"),
            options.GeneratedProjectPaths!![Path.Combine(source, "src", "Interop", "Interop.csproj")]
        )
        Assert.NotNull(probe!!.Observation)
        return probe!!.Observation
    }

    private data class Fixture(
        Source string,
        Migrated string,
        Manifests string,
        ManifestPath string,
        ManifestBytes[]uint8,
        AppId string
    ) : IEquatable[Issue4752PortableValidationSourcesTests.Fixture] { }

    private data class Observation(Facts int32, Budget TimeSpan, Files IReadOnlyList[EmittedGsFile]) : IEquatable[
        Observation
    ] { }

    private class SourceEvidenceStage : IMigrationStage {
        prop Kind MigrationStageKind -> MigrationStageKind.TestParity

        internal prop Observation Observation? {
            get;
            private set;
        }

        func ExecuteAsync(
            context StageExecutionContext,
            cancellationToken CancellationToken = default(CancellationToken)
        ) Task[StageOutcome] {
            let facts = TestParityStage.CountCSharpFactMethods(context)
            this.Observation = Observation(
                facts,
                SdkCompileRunner.MirroredTestRunTimeoutFor(facts),
                context.EmittedFiles.ToArray()
            )
            return Task.FromResult(StageOutcome.Skipped())
        }
    }

    shared {
        private func Compiler() string? {
            let compiler string? = GscInvoker.Resolve(nil, "Release", GsharpTestProjectRunner.FindRepoRoot()!!)
            Assert.NotNull(compiler)
            Assert.True(File.Exists(compiler))
            return compiler
        }

        private func Facts(count int32) string -> "public class Tests {\n" + string.Concat(
            Enumerable.Range(0, count).Select((index int32) -> (`[Fact] public void Case` + "$index" + `() {}
`))
        ) +
            "}\n"

        private func Write(path string, text string) {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!!)
            File.WriteAllText(path, text)
        }
    }
}
