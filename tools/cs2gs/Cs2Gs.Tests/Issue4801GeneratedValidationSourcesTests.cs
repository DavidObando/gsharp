// <copyright file="Issue4801GeneratedValidationSourcesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Generated compilation inputs survive transport without borrowing a validator's configuration.</summary>
public sealed class Issue4801GeneratedValidationSourcesTests : IDisposable
{
    private readonly string root = Path.Combine(
        Environment.GetEnvironmentVariable("CS2GS_4801_EVIDENCE_ROOT") ?? Path.GetTempPath(),
        "cs2gs-4801-" + Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData("net10.0", ".NETCoreApp,Version=v10.0")]
    [InlineData("netstandard2.0", ".NETStandard,Version=v2.0")]
    public async Task RealDriver_DebugGeneratedInputsReplayAgainstCleanReleaseCorpus(string tfm, string framework)
    {
        string producer = Path.Combine(this.root, "producer");
        string authoritative = Path.Combine(this.root, "authoritative");
        string migrated = Path.Combine(this.root, "migrated");
        string manifests = Path.Combine(this.root, "manifests");
        string compiler = GscInvoker.Resolve(null, "Release", GsharpTestProjectRunner.FindRepoRoot());
        Assert.NotNull(compiler);
        Console.WriteLine("hydration product: " + typeof(ValidationManifest).Assembly.Location + " SHA256 " +
            Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(ValidationManifest).Assembly.Location))));
        Write(Path.Combine(producer, "Directory.Build.props"), """
            <Project>
              <PropertyGroup>
                <BaseIntermediateOutputPath>$(MSBuildThisFileDirectory)out/obj/$(MSBuildProjectName)/</BaseIntermediateOutputPath>
                <BaseOutputPath>$(MSBuildThisFileDirectory)out/bin/$(MSBuildProjectName)/</BaseOutputPath>
              </PropertyGroup>
            </Project>
            """);
        Write(Path.Combine(producer, "Directory.Build.targets"), "<Project />");
        Write(Path.Combine(producer, "src", "Probe", "Probe.csproj"), $$"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>{{tfm}}</TargetFramework>
                <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
                <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
                <DebugType>portable</DebugType>
              </PropertyGroup>
              <ItemGroup>
                <Compile Include="$(IntermediateOutputPath)ProducerDeclaration.cs" />
              </ItemGroup>
              <Target Name="ProduceDeclaration" BeforeTargets="CoreCompile">
                <WriteLinesToFile File="$(IntermediateOutputPath)ProducerDeclaration.cs"
                    Lines="[assembly: System.Reflection.AssemblyMetadata(&quot;ProducerConfiguration&quot;, &quot;$(Configuration)&quot;)]"
                    Overwrite="true" />
                <ReadLinesFromFile File="ProducerDeclaration.txt">
                  <Output TaskParameter="Lines" ItemName="DeclarationLines" />
                </ReadLinesFromFile>
                <WriteLinesToFile File="$(IntermediateOutputPath)ProducerDeclaration.cs" Lines="@(DeclarationLines)" />
              </Target>
              <Target Name="RecordCompilation" AfterTargets="CoreCompile">
                <WriteLinesToFile File="$(IntermediateOutputPath)csc-sources.txt" Lines="@(Compile->'%(FullPath)')" Overwrite="true" />
                <WriteLinesToFile File="$(IntermediateOutputPath)csc-references.txt" Lines="@(ReferencePath->'%(FullPath)')" Overwrite="true" />
              </Target>
            </Project>
            """);
        Write(Path.Combine(producer, "src", "Probe", "Authored.cs"),
            "public class FactAttribute : System.Attribute {}\npublic class Authored {\n" +
            string.Concat(Enumerable.Range(0, 400).Select(i => $"[Fact] public void Case{i}() {{}}\n")) + "}\n");
        Write(Path.Combine(producer, "src", "Probe", "ProducerDeclaration.txt"), """
            namespace Native.Generated {
                public class Declaration {
                    public static int Value() => 73;
                    [Fact] public void A() {}
                    [Fact] public void B() {}
                    [Fact] public void C() {}
                }
                public class Extra {}
            }
            """);
        await Run(producer, "dotnet", "restore", "src/Probe/Probe.csproj", "--locked-mode", "-nr:false");
        await Run(producer, "dotnet", "build", "src/Probe/Probe.csproj", "-c", "Debug", "--no-restore", "-nr:false",
            "-bl:producer.binlog");
        string nativeAssembly = Path.Combine(producer, "out", "bin", "Probe", "Debug", tfm, "Probe.dll");
        AssertNative(nativeAssembly, framework, "Debug");
        AssertNativeSources(nativeAssembly);

        // Only the authored inventory crosses into the validator's source root.
        foreach (string relative in RepositoryFileInventory.Enumerate(producer))
        {
            string destination = Path.Combine(authoritative, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            File.Copy(Path.Combine(producer, relative), destination);
        }

        await Run(authoritative, "dotnet", "restore", "src/Probe/Probe.csproj", "--locked-mode", "-nr:false");
        await Run(authoritative, "dotnet", "build", "src/Probe/Probe.csproj", "-c", "Release",
            "--no-restore", "-nr:false");
        AssertNative(Path.Combine(authoritative, "out", "bin", "Probe", "Release", tfm, "Probe.dll"), framework, "Release");
        string cli = Path.Combine(GsharpTestProjectRunner.FindRepoRoot(), "out", "bin", "Release", "Cs2Gs.Cli", "cs2gs.dll");
        var sdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(GsharpTestProjectRunner.FindRepoRoot());
        Assert.NotNull(sdk);
        string producerAlias = Path.Combine(this.root, "producer-alias");
        Directory.CreateSymbolicLink(producerAlias, producer);
        await Run(this.root, "dotnet", cli, "migrate", "--corpus", producerAlias, "--out", migrated,
            "--artifacts", manifests, "--gsc", compiler, "--translate-only", "--sdk-version", sdk.Value.Version);
        string producingRun = Assert.Single(Directory.GetDirectories(manifests));
        string artifact = Path.Combine(producingRun,
            MigrationPipeline.ArtifactDirectoryName("src/Probe/Probe.csproj", MigrationOutputLayout.Repository));
        ValidationManifest manifest = ValidationManifest.Read(artifact);
        Assert.NotNull(manifest);
        byte[] manifestBytes = File.ReadAllBytes(Path.Combine(artifact, ValidationManifest.FileName));
        string[] generatedPaths = manifest.EmittedFiles
            .Where(f => RepositoryFileInventory.IsBuildOutputPath(f.RelativeCsPath))
            .Select(f => f.RelativeCsPath).Distinct().ToArray();
        Assert.True(generatedPaths.Length >= 2);
        Assert.Contains(generatedPaths, path => path.Contains(framework + ".AssemblyAttributes.cs", StringComparison.Ordinal));
        Assert.All(generatedPaths, path => Assert.False(File.Exists(Path.Combine(authoritative, path))));
        Assert.False(Directory.Exists(Path.Combine(authoritative, "out", "obj", "Probe", "Debug")));
        string vanishedProducer = Path.Combine(this.root, "vanished-producer");
        Directory.Move(producer, vanishedProducer);

        var probe = new EvidenceStage();
        CorpusApp app = Assert.Single(RepositoryDiscovery.Discover(authoritative));
        var options = new PipelineOptions
        {
            SourceRoot = authoritative,
            OutputRoot = migrated,
            ArtifactRoot = Path.Combine(this.root, "validation"),
            GscPath = compiler,
            CompileViaSdk = false,
        };
        RunResult result = await new MigrationPipeline(options, new IMigrationStage[]
        {
            new CompileStage(), new IlVerifyStage(), probe,
        }).ValidateAsync(new[] { app }, new[] { app }, producingRun);
        Assert.True(result.Succeeded, JsonSerializer.Serialize(result, TriageSerialization.Options));
        AppResult validatedApp = Assert.Single(result.Apps);
        Assert.Equal("passed", validatedApp.Stages.Single(s => s.Stage == "compile").Status);
        Assert.Equal("passed", validatedApp.Stages.Single(s => s.Stage == "ilverify").Status);
        Assert.NotNull(probe.Context);
        Assert.Equal(403, TestParityStage.CountCSharpFactMethods(probe.Context));
        Assert.Equal(TimeSpan.FromMinutes(16), SdkCompileRunner.MirroredTestRunTimeoutFor(403));
        Assert.Equal(manifest.EmittedFiles.Count, probe.Context.EmittedFiles.Count);
        EmittedGsFile[] generated = probe.Context.EmittedFiles.Where(f => f.GeneratedSource is not null).ToArray();
        Assert.True(generated.Length >= 2);
        Assert.All(generated, file =>
        {
            Assert.Equal("src/Probe/Probe.csproj", file.GeneratedSource.SourceProjectPath);
            Assert.Equal(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(file.GeneratedSource.Text))),
                file.GeneratedSource.Sha256);
            Assert.StartsWith(authoritative + Path.DirectorySeparatorChar, file.CsFilePath);
            Assert.False(File.Exists(file.CsFilePath));
            Assert.False(file.IsFromReferencedProject);
        });
        AssertNative(probe.Context.EmittedAssemblyPath, framework, "Debug");
        Assert.Equal(manifestBytes, File.ReadAllBytes(Path.Combine(artifact, ValidationManifest.FileName)));
        Assert.Equal(1, probe.Context.EmittedFiles.Count(f => f.GeneratedSource is null));

        // An existing stale producer must not change replay, either.
        foreach (string relative in generatedPaths)
        {
            Write(Path.Combine(producer, relative), "public class Wrong {}");
        }

        var repeated = new EvidenceStage();
        RunResult stale = await new MigrationPipeline(options, new IMigrationStage[] { repeated })
            .ValidateAsync(new[] { app }, new[] { app }, producingRun);
        Assert.True(stale.Succeeded);
        Assert.Equal(403, TestParityStage.CountCSharpFactMethods(repeated.Context));
    }

    [Theory]
    [InlineData("hash")]
    [InlineData("text")]
    [InlineData("owner")]
    [InlineData("ownership-flag")]
    [InlineData("authored-payload")]
    [InlineData("owner-escape")]
    [InlineData("source-escape")]
    [InlineData("missing-payload")]
    public void Hydrate_GeneratedEvidenceCannotBypassIdentityOrAuthoredSourceChecks(string invalid)
    {
        string source = Path.Combine(this.root, "source");
        string migrated = Path.Combine(this.root, "migrated");
        Write(Path.Combine(source, "Probe.csproj"), "<Project />");
        Write(Path.Combine(migrated, "obj", "Generated.gs"), "package Probe\n");
        string generated = Path.Combine(source, "obj", "Generated.cs");
        var app = new CorpusApp("Probe.csproj", Path.Combine(source, "Probe.csproj"), TargetKind.Library);
        var context = new StageExecutionContext(app, new PipelineOptions { SourceRoot = source },
            new GscInvoker("unused"), migrated, new TriageBuilder("capture", "ts", "gsc", app.Id));
        context.EmittedFiles.Add(new EmittedGsFile(Path.Combine(migrated, "obj", "Generated.gs"), "Generated.gs",
            generated, "package Probe\n")
        {
            GeneratedSource = GeneratedValidationSource.Capture("public class Generated {}", "Probe.csproj"),
        });
        ValidationManifest manifest = ValidationManifest.Capture(context, true, migrated);
        ValidationManifestFile file = Assert.Single(manifest.EmittedFiles);
        var control = new StageExecutionContext(app, context.Options, context.Gsc, migrated, context.Triage);
        manifest.Hydrate(control, migrated);
        Assert.Single(control.EmittedFiles);
        Assert.Equal("public class Generated {}", control.EmittedFiles[0].GeneratedSource.Text);
        switch (invalid)
        {
            case "hash": file.GeneratedSource.Sha256 = new string('0', 64); break;
            case "text": file.GeneratedSource.Text = null; break;
            case "owner": file.GeneratedSource.SourceProjectPath = "Other.csproj"; break;
            case "ownership-flag": file.FromReferencedProject = true; break;
            case "authored-payload":
                file.CsFilePath = Path.Combine(source, "Authored.cs");
                file.RelativeCsPath = "Authored.cs";
                break;
            case "owner-escape": file.GeneratedSource.SourceProjectPath = "../Probe.csproj"; break;
            case "source-escape":
                file.CsFilePath = source + "/../obj/Generated.cs";
                file.RelativeCsPath = "../obj/Generated.cs";
                break;
            case "missing-payload": file.GeneratedSource = null; break;
        }

        var hydrate = new StageExecutionContext(app, context.Options, context.Gsc, migrated, context.Triage);
        Assert.Throws<InvalidOperationException>(() => manifest.Hydrate(hydrate, migrated));
        Assert.Empty(hydrate.EmittedFiles);
    }

    public void Dispose()
    {
        if (Environment.GetEnvironmentVariable("CS2GS_4801_EVIDENCE_ROOT") is null && Directory.Exists(this.root))
        {
            Directory.Delete(this.root, recursive: true);
            Console.WriteLine("native fixture root deleted: " + this.root);
        }
    }

    private static void AssertNative(string path, string framework, string configuration)
    {
        Assembly assembly = EmittedFixture.Load(path);
        Assert.True(assembly.IsCollectible);
        Assert.Empty(assembly.Location);
        Console.WriteLine("native byte-load: " + path + " MVID " + assembly.ManifestModule.ModuleVersionId +
            " SHA256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))));
        CustomAttributeData target = Assert.Single(assembly.GetCustomAttributesData(),
            a => a.AttributeType.FullName == "System.Runtime.Versioning.TargetFrameworkAttribute");
        Assert.Equal(framework, target.ConstructorArguments[0].Value);
        Assert.Same(typeof(System.Runtime.Versioning.TargetFrameworkAttribute).Assembly, target.AttributeType.Assembly);
        CustomAttributeData configurationAttribute = Assert.Single(assembly.GetCustomAttributesData(),
            a => a.AttributeType.FullName == "System.Reflection.AssemblyMetadataAttribute");
        Assert.Equal("ProducerConfiguration", configurationAttribute.ConstructorArguments[0].Value);
        Assert.Equal(configuration, configurationAttribute.ConstructorArguments[1].Value);
        Type declaration = assembly.GetType("Native.Generated.Declaration", throwOnError: true);
        Assert.Equal(73, declaration.GetMethod("Value").Invoke(null, null));
        Assert.NotNull(assembly.GetType("Native.Generated.Extra"));
    }

    private static void AssertNativeSources(string assemblyPath)
    {
        using FileStream pdb = File.OpenRead(Path.ChangeExtension(assemblyPath, ".pdb"));
        using MetadataReaderProvider provider = MetadataReaderProvider.FromPortablePdbStream(pdb);
        MetadataReader reader = provider.GetMetadataReader();
        Document[] documents = reader.Documents.Select(reader.GetDocument).ToArray();
        Assert.NotEmpty(documents);
        var inventory = new List<object>();
        foreach (Document document in documents)
        {
            string path = reader.GetString(document.Name);
            byte[] hash = reader.GetBlobBytes(document.Hash);
            Assert.Equal(SHA256.HashData(File.ReadAllBytes(path)), hash);
            inventory.Add(new { path, sha256 = Convert.ToHexString(hash) });
        }

        Console.WriteLine("native Csc/PDB source inventory: " + JsonSerializer.Serialize(inventory));
    }

    private static async Task Run(string cwd, string command, params string[] args)
    {
        ProcessRunResult result = await ProcessRunner.RunAsync(command, args, cwd, TimeSpan.FromMinutes(2));
        Console.WriteLine(command + " " + string.Join(" ", args) + "\n" + result.Output);
        Assert.False(result.TimedOut);
        Assert.True(result.ExitCode == 0, result.Output);
    }

    private static void Write(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, text);
    }

    private sealed class EvidenceStage : IMigrationStage
    {
        public MigrationStageKind Kind => MigrationStageKind.TestParity;

        internal StageExecutionContext Context { get; private set; }

        public Task<StageOutcome> ExecuteAsync(StageExecutionContext context, CancellationToken cancellationToken = default)
        {
            this.Context = context;
            return Task.FromResult(StageOutcome.Skipped());
        }
    }
}
