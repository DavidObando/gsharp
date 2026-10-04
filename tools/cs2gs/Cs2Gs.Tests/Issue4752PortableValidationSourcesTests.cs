// <copyright file="Issue4752PortableValidationSourcesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Artifact replay must retain original source identity, ownership and the existing Fact budget.</summary>
public sealed class Issue4752PortableValidationSourcesTests : IDisposable
{
    private readonly string root = Path.Combine(
        Path.GetFullPath(Path.GetTempPath()), "cs2gs-4752-" + Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Validate_RelocatedSourcesMatchNonrelocatedCountAndBudget(bool legacy)
    {
        Fixture fixture = this.CreateFixture(legacy);
        Observation control = await this.Validate(fixture, fixture.Source);
        Assert.Equal(403, control.Facts);
        Assert.Equal(TimeSpan.FromMinutes(16), control.Budget);
        string relocated = Path.Combine(this.root, "relocated");
        Directory.Move(fixture.Source, relocated);

        Observation replay = await this.Validate(fixture, relocated);

        Assert.Equal(control.Facts, replay.Facts);
        Assert.Equal(control.Budget, replay.Budget);
        Assert.Equal(5, replay.Files.Count);
        Assert.Equal(1, replay.Files.Count(file => file.IsFromReferencedProject));
        Assert.Equal(2, replay.Files.Count(file => file.CsFilePath == Path.Combine(relocated, "test", "Shared", "Linked.cs")));
        Assert.Contains(replay.Files, file => file.CsFilePath == Path.Combine(relocated, "test", "Own", "Strings.resx"));
        Assert.All(replay.Files, file => Assert.StartsWith(relocated + Path.DirectorySeparatorChar, file.CsFilePath));
        Assert.Equal(fixture.ManifestBytes, File.ReadAllBytes(fixture.ManifestPath));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Validate_UsesAuthorizedCorpusEvenWhenProducingPathStillExists(bool legacy)
    {
        Fixture fixture = this.CreateFixture(legacy);
        string relocated = Path.Combine(this.root, "relocated");
        Directory.Move(fixture.Source, relocated);
        Write(Path.Combine(fixture.Source, "test", "Own", "Tests.cs"), Facts(1));
        Write(Path.Combine(fixture.Source, "test", "Shared", "Linked.cs"), Facts(1));

        Observation replay = await this.Validate(fixture, relocated);

        Assert.Equal(403, replay.Facts);
        Assert.Equal(TimeSpan.FromMinutes(16), replay.Budget);
    }

    [Theory]
    [InlineData(false, "test/Shared/Linked.cs")]
    [InlineData(true, "test/Shared/Linked.cs")]
    [InlineData(false, "test/Own/Tests.cs")]
    [InlineData(true, "test/Own/Tests.cs")]
    public async Task Validate_MissingAuthoritativeSourceFailsBeforeStages(bool legacy, string missing)
    {
        Fixture fixture = this.CreateFixture(legacy);
        File.Delete(Path.Combine(fixture.Source, missing));
        var probe = new SourceEvidenceStage();

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => this.Validate(fixture, fixture.Source, probe));

        Assert.Contains("missing from authoritative corpus", error.Message, StringComparison.Ordinal);
        Assert.Null(probe.Observation);
    }

    [Theory]
    [InlineData("app")]
    [InlineData("project")]
    [InlineData("identity")]
    [InlineData("source-escape")]
    [InlineData("migrated-escape")]
    [InlineData("absolute")]
    [InlineData("incomplete")]
    [InlineData("producing-escape")]
    [InlineData("empty-source")]
    [InlineData("empty-identity")]
    public async Task Validate_InvalidManifestIdentityFailsBeforeStages(string invalid)
    {
        Fixture fixture = this.CreateFixture(legacy: false);
        ValidationManifest manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath));
        Assert.NotNull(manifest);
        switch (invalid)
        {
            case "app":
                manifest.AppId = "src/Unrelated/Unrelated.csproj";
                break;
            case "project":
                manifest.SourceProjectPath = "src/Lib/Lib.csproj";
                break;
            case "identity":
                manifest.EmittedFiles[0].RelativeCsPath = "test/Shared/Linked.cs";
                break;
            case "source-escape":
                manifest.EmittedFiles[0].CsFilePath = manifest.SourceRoot + "/../outside.cs";
                manifest.EmittedFiles[0].RelativeCsPath = "../outside.cs";
                break;
            case "migrated-escape":
                manifest.EmittedFiles[0].Path = "../outside.gs";
                break;
            case "absolute":
                manifest.EmittedFiles[0].Path = Path.Combine(this.root, "outside.gs");
                break;
            case "incomplete":
                manifest.SourceRoot = null;
                break;
            case "producing-escape":
                manifest.SourceRoot += "/..";
                foreach (ValidationManifestFile file in manifest.EmittedFiles)
                {
                    file.CsFilePath = manifest.SourceRoot + "/" + file.RelativeCsPath;
                }
                break;
            case "empty-source":
                manifest.EmittedFiles[0].CsFilePath = null;
                break;
            case "empty-identity":
                manifest.EmittedFiles[0].CsFilePath = null;
                manifest.EmittedFiles[0].RelativeCsPath = null;
                break;
        }

        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath));
        var probe = new SourceEvidenceStage();
        await Assert.ThrowsAsync<InvalidOperationException>(() => this.Validate(fixture, fixture.Source, probe));
        Assert.Null(probe.Observation);
    }

    [Fact]
    public async Task Validate_LegacyConflictingRootsAreNotSelectedByFileExistence()
    {
        Fixture fixture = this.CreateFixture(legacy: true);
        ValidationManifest manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath));
        Assert.NotNull(manifest);
        manifest.EmittedFiles[2].CsFilePath = Path.Combine(this.root, "unrelated", "src", "Lib", "Tests.cs");
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath));
        var probe = new SourceEvidenceStage();

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => this.Validate(fixture, fixture.Source, probe));

        Assert.Contains("unambiguous owning corpus source root", error.Message, StringComparison.Ordinal);
        Assert.Null(probe.Observation);
    }

    [Fact]
    public async Task Validate_LegacyReferencedSourcesCannotEstablishAppOwnership()
    {
        Fixture fixture = this.CreateFixture(legacy: true);
        ValidationManifest manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath));
        Assert.NotNull(manifest);
        manifest.EmittedFiles.RemoveAll(file => !file.FromReferencedProject);
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath));
        var probe = new SourceEvidenceStage();

        await Assert.ThrowsAsync<InvalidOperationException>(() => this.Validate(fixture, fixture.Source, probe));
        Assert.Null(probe.Observation);
    }

    [Fact]
    public async Task Validate_LegacyLinkedSourceCanEstablishItsDeclaringProjectOwnership()
    {
        Fixture fixture = this.CreateFixture(legacy: true);
        ValidationManifest manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath));
        Assert.NotNull(manifest);
        manifest.EmittedFiles.RemoveAll(file =>
            Path.GetRelativePath(fixture.Source, file.CsFilePath).Replace('\\', '/') != "test/Shared/Linked.cs");
        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath));
        string relocated = Path.Combine(this.root, "relocated");
        Directory.Move(fixture.Source, relocated);

        Observation replay = await this.Validate(fixture, relocated);

        Assert.Equal(2, replay.Files.Count);
        Assert.Equal(3, replay.Facts);
        Assert.Equal(TimeSpan.FromMinutes(10), replay.Budget);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Validate_SourceSymlinkCannotEscapeAuthorizedCorpus(bool legacy)
    {
        Fixture fixture = this.CreateFixture(legacy);
        string source = Path.Combine(fixture.Source, "test", "Own", "Tests.cs");
        string outside = Path.Combine(this.root, "outside.cs");
        File.Move(source, outside);
        File.CreateSymbolicLink(source, outside);
        var probe = new SourceEvidenceStage();

        await Assert.ThrowsAsync<InvalidOperationException>(() => this.Validate(fixture, fixture.Source, probe));
        Assert.Null(probe.Observation);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Validate_PortablePathsAcceptWindowsProducerProvenance(bool legacy)
    {
        Fixture fixture = this.CreateFixture(legacy);
        ValidationManifest manifest = ValidationManifest.Read(Path.GetDirectoryName(fixture.ManifestPath));
        Assert.NotNull(manifest);
        if (!legacy)
        {
            manifest.SourceRoot = @"C:\RUNNER\GSHARP";
            manifest.SourceProjectPath = manifest.SourceProjectPath.Replace('/', '\\');
        }

        int index = 0;
        foreach (ValidationManifestFile file in manifest.EmittedFiles)
        {
            string relative = Path.GetRelativePath(fixture.Source, file.CsFilePath).Replace('/', '\\');
            if (!legacy)
            {
                file.RelativeCsPath = relative;
            }

            file.CsFilePath = (index++ % 2 == 0 ? @"c:\runner\gsharp\" : @"C:\RUNNER\GSHARP\") + relative;
            file.Path = file.Path.Replace('/', '\\');
        }

        ValidationManifest.Write(manifest, Path.GetDirectoryName(fixture.ManifestPath));
        Observation replay = await this.Validate(fixture, fixture.Source);
        Assert.Equal(403, replay.Facts);
        Assert.Equal(TimeSpan.FromMinutes(16), replay.Budget);
    }

    public void Dispose()
    {
        if (Directory.Exists(this.root))
        {
            Directory.Delete(this.root, recursive: true);
        }
    }

    private Fixture CreateFixture(bool legacy)
    {
        string source = Path.Combine(this.root, "source");
        string migrated = Path.Combine(this.root, "migrated");
        Write(Path.Combine(source, "test", "Own", "Own.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
              <ItemGroup>
                <Compile Include="../Shared/Linked.cs" Link="Linked.cs" />
                <ProjectReference Include="../../src/Lib/Lib.csproj" />
                <ProjectReference Include="../../src/Interop/Interop.csproj" ReferenceOutputAssembly="false" />
              </ItemGroup>
            </Project>
            """);
        Write(Path.Combine(source, "src", "Lib", "Lib.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
        Write(Path.Combine(source, "src", "Interop", "Interop.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
        Write(Path.Combine(source, "test", "Own", "Tests.cs"), Facts(400));
        Write(Path.Combine(source, "test", "Shared", "Linked.cs"), Facts(3));
        Write(Path.Combine(source, "src", "Lib", "Tests.cs"), Facts(900));
        Write(Path.Combine(source, "test", "Own", "Strings.resx"), "<root />");

        var app = RepositoryDiscovery.Discover(source).Single(app => app.Id == "test/Own/Own.csproj");
        var context = new StageExecutionContext(
            app, new PipelineOptions { SourceRoot = source },
            new GscInvoker(Compiler()), migrated,
            new TriageBuilder("capture", "ts", "gsc", app.Id));
        context.IsTestProject = true;
        Add("test/Own/Tests.gs", "test/Own/Tests.cs", referenced: false);
        Add("test/Shared/Linked.gs", "test/Shared/Linked.cs", referenced: false);
        Add("src/Lib/Tests.gs", "src/Lib/Tests.cs", referenced: true);
        Add("test/Shared/Linked.Second.gs", "test/Shared/Linked.cs", referenced: false);
        Add("test/Own/Strings.Designer.gs", "test/Own/Strings.resx", referenced: false);
        string manifests = Path.Combine(this.root, "manifests");
        string artifact = Path.Combine(manifests, MigrationPipeline.ArtifactDirectoryName(app.Id, MigrationOutputLayout.Repository));
        ValidationManifest manifest = ValidationManifest.Capture(context, translated: true, migrated);
        if (legacy)
        {
            manifest.SourceRoot = null;
            manifest.SourceProjectPath = null;
            foreach (ValidationManifestFile file in manifest.EmittedFiles)
            {
                file.RelativeCsPath = null;
            }
        }

        ValidationManifest.Write(manifest, artifact);
        string manifestPath = Path.Combine(artifact, ValidationManifest.FileName);
        return new Fixture(source, migrated, manifests, manifestPath, File.ReadAllBytes(manifestPath), app.Id);

        void Add(string gs, string cs, bool referenced)
        {
            string gsPath = Path.Combine(migrated, gs);
            Write(gsPath, "package Fixture\n");
            context.EmittedFiles.Add(new EmittedGsFile(gsPath, gs, Path.Combine(source, cs), "package Fixture\n")
            {
                IsFromReferencedProject = referenced,
            });
        }
    }

    private async Task<Observation> Validate(Fixture fixture, string source, SourceEvidenceStage probe = null)
    {
        IReadOnlyList<CorpusApp> apps = RepositoryDiscovery.Discover(source);
        CorpusApp app = apps.Single(app => app.Id == fixture.AppId);
        probe ??= new SourceEvidenceStage();
        var options = new PipelineOptions
        {
            SourceRoot = source,
            OutputRoot = fixture.Migrated,
            ArtifactRoot = Path.Combine(this.root, "observations"),
            GscPath = Compiler(),
        };
        options.PassthroughProjectPaths.Add(Path.Combine(source, "src", "Interop", "Interop.csproj"));
        RunResult result = await new MigrationPipeline(options, new IMigrationStage[] { probe })
            .ValidateAsync(apps, new[] { app }, fixture.Manifests);
        Assert.True(result.Succeeded);
        Assert.True(result.Unverified);
        Assert.Equal("skipped", Assert.Single(Assert.Single(result.Apps).Stages).Status);
        Assert.Equal(
            Path.Combine(fixture.Migrated, "src", "Interop", "Interop.csproj"),
            options.GeneratedProjectPaths[Path.Combine(source, "src", "Interop", "Interop.csproj")]);
        Assert.NotNull(probe.Observation);
        return probe.Observation;
    }

    private static string Compiler()
    {
        string compiler = GscInvoker.Resolve(null, "Release", GsharpTestProjectRunner.FindRepoRoot());
        Assert.NotNull(compiler);
        Assert.True(File.Exists(compiler));
        return compiler;
    }

    private static string Facts(int count) =>
        "public class Tests {\n" + string.Concat(Enumerable.Range(0, count)
            .Select(index => $"[Fact] public void Case{index}() {{}}\n")) + "}\n";

    private static void Write(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, text);
    }

    private sealed record Fixture(
        string Source, string Migrated, string Manifests, string ManifestPath, byte[] ManifestBytes, string AppId);

    private sealed record Observation(int Facts, TimeSpan Budget, IReadOnlyList<EmittedGsFile> Files);

    private sealed class SourceEvidenceStage : IMigrationStage
    {
        public MigrationStageKind Kind => MigrationStageKind.TestParity;

        internal Observation Observation { get; private set; }

        public Task<StageOutcome> ExecuteAsync(StageExecutionContext context, CancellationToken cancellationToken = default)
        {
            int facts = TestParityStage.CountCSharpFactMethods(context);
            this.Observation = new Observation(facts, SdkCompileRunner.MirroredTestRunTimeoutFor(facts), context.EmittedFiles.ToArray());
            return Task.FromResult(StageOutcome.Skipped());
        }
    }
}
