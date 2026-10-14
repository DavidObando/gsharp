// <copyright file="Issue4801GeneratedValidationSourcesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Runtime.Versioning
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import Xunit

/// Generated compilation inputs survive transport without borrowing a validator's configuration.
class Issue4801GeneratedValidationSourcesTests : IDisposable {
    private let root string = Path.Combine(
        Environment.GetEnvironmentVariable("CS2GS_4801_EVIDENCE_ROOT") ?? Path.GetTempPath(),
        "cs2gs-4801-" + Guid.NewGuid().ToString("N")
    )

    @Theory
    @InlineData("net10.0", ".NETCoreApp,Version=v10.0")
    @InlineData("netstandard2.0", ".NETStandard,Version=v2.0")
    async func RealDriver_DebugGeneratedInputsReplayAgainstCleanReleaseCorpus(tfm string, framework string) {
        let producer = Path.Combine(this.root, "producer")
        let authoritative = Path.Combine(this.root, "authoritative")
        let migrated = Path.Combine(this.root, "migrated")
        let manifests = Path.Combine(this.root, "manifests")
        let compiler string? = GscInvoker.Resolve(nil, "Release", GsharpTestProjectRunner.FindRepoRoot()!!)
        Assert.NotNull(compiler)
        Console.WriteLine(
            "hydration product: " + typeof(ValidationManifest).Assembly.Location + " SHA256 " + Convert.ToHexString(
                SHA256.HashData(File.ReadAllBytes(typeof(ValidationManifest).Assembly.Location))
            )
        )
        Write(Path.Combine(producer, "Directory.Build.props"), `<Project>
  <PropertyGroup>
    <BaseIntermediateOutputPath>$(MSBuildThisFileDirectory)out/obj/$(MSBuildProjectName)/</BaseIntermediateOutputPath>
    <BaseOutputPath>$(MSBuildThisFileDirectory)out/bin/$(MSBuildProjectName)/</BaseOutputPath>
  </PropertyGroup>
</Project>`)
        Write(Path.Combine(producer, "Directory.Build.targets"), "<Project />")
        Write(Path.Combine(producer, "src", "Probe", "Probe.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>` + "$tfm" + `</TargetFramework>
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
</Project>`))
        Write(Path.Combine(producer, "src", "Probe", "Authored.cs"), `public class FactAttribute : System.Attribute {}
public class Authored {
` + string.Concat(Enumerable.Range(0, 400).Select((i int32) -> (`[Fact] public void Case` + "$i" + `() {}
`))) + "}\n")
        Write(Path.Combine(producer, "src", "Probe", "ProducerDeclaration.txt"), `namespace Native.Generated {
    public class Declaration {
        public static int Value() => 73;
        [Fact] public void A() {}
        [Fact] public void B() {}
        [Fact] public void C() {}
    }
    public class Extra {}
}`)
        await Run(producer, "dotnet", "restore", "src/Probe/Probe.csproj", "--locked-mode", "-nr:false")
        await Run(
            producer,
            "dotnet",
            "build",
            "src/Probe/Probe.csproj",
            "-c",
            "Debug",
            "--no-restore",
            "-nr:false",
            "-bl:producer.binlog"
        )
        let nativeAssembly = Path.Combine(producer, "out", "bin", "Probe", "Debug", tfm, "Probe.dll")
        AssertNative(nativeAssembly, framework, "Debug")
        AssertNativeSources(nativeAssembly)
        // Only the authored inventory crosses into the validator's source root.
        for relative in RepositoryFileInventory.Enumerate(producer) {
            let destination = Path.Combine(authoritative, relative)
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!!)
            File.Copy(Path.Combine(producer, relative), destination)
        }
        await Run(authoritative, "dotnet", "restore", "src/Probe/Probe.csproj", "--locked-mode", "-nr:false")
        await Run(
            authoritative,
            "dotnet",
            "build",
            "src/Probe/Probe.csproj",
            "-c",
            "Release",
            "--no-restore",
            "-nr:false"
        )
        AssertNative(
            Path.Combine(authoritative, "out", "bin", "Probe", "Release", tfm, "Probe.dll"),
            framework,
            "Release"
        )
        let cli = Path.Combine(
            GsharpTestProjectRunner.FindRepoRoot()!!,
            "out",
            "bin",
            "Release",
            "Cs2Gs.Cli",
            "cs2gs.dll"
        )
        let sdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(GsharpTestProjectRunner.FindRepoRoot())
        Assert.NotNull(sdk)
        let producerAlias = Path.Combine(this.root, "producer-alias")
        Directory.CreateSymbolicLink(producerAlias, producer)
        await Run(
            this.root,
            "dotnet",
            cli,
            "migrate",
            "--corpus",
            producerAlias,
            "--out",
            migrated,
            "--artifacts",
            manifests,
            "--gsc",
            compiler,
            "--translate-only",
            "--sdk-version",
            sdk!!.Version
        )
        let producingRun = Assert.Single(Directory.GetDirectories(manifests))
        let artifact = Path.Combine(
            producingRun,
            MigrationPipeline.ArtifactDirectoryName("src/Probe/Probe.csproj", MigrationOutputLayout.Repository)
        )
        let manifest = ValidationManifest.Read(artifact)!!
        Assert.NotNull(manifest)
        let manifestBytes = File.ReadAllBytes(Path.Combine(artifact, ValidationManifest.FileName))
        let generatedPaths = manifest
            .EmittedFiles
            .Where((f ValidationManifestFile) -> RepositoryFileInventory.IsBuildOutputPath(f.RelativeCsPath))
            .Select((f ValidationManifestFile) -> f.RelativeCsPath!!)
            .Distinct()
            .ToArray()
        Assert.True(generatedPaths.Length >= 2)
        Assert.Contains(
            generatedPaths,
            (path string) -> path.Contains(framework + ".AssemblyAttributes.cs", StringComparison.Ordinal)
        )
        Assert.All(generatedPaths, (path string) -> Assert.False(File.Exists(Path.Combine(authoritative, path))))
        Assert.False(Directory.Exists(Path.Combine(authoritative, "out", "obj", "Probe", "Debug")))
        let vanishedProducer = Path.Combine(this.root, "vanished-producer")
        Directory.Move(producer, vanishedProducer)
        let probe = EvidenceStage()
        let app = Assert.Single(RepositoryDiscovery.Discover(authoritative))
        let options = PipelineOptions{
            SourceRoot: authoritative,
            OutputRoot: migrated,
            ArtifactRoot: Path.Combine(this.root, "validation"),
            GscPath: compiler,
            CompileViaSdk: false
        }
        let result = await MigrationPipeline(
            options,
            []IMigrationStage{CompileStage(), IlVerifyStage(), probe}
        ).ValidateAsync([]CorpusApp{app}, []CorpusApp{app}, producingRun)
        Assert.True(result.Succeeded, JsonSerializer.Serialize(result, TriageSerialization.Options))
        let validatedApp = Assert.Single(result.Apps)
        Assert.Equal("passed", validatedApp.Stages.Single((s StageResult) -> s.Stage == "compile").Status)
        Assert.Equal("passed", validatedApp.Stages.Single((s StageResult) -> s.Stage == "ilverify").Status)
        Assert.NotNull(probe.Context)
        Assert.Equal(403, TestParityStage.CountCSharpFactMethods(probe.Context))
        Assert.Equal(TimeSpan.FromMinutes(16), SdkCompileRunner.MirroredTestRunTimeoutFor(403))
        Assert.Equal(manifest.EmittedFiles.Count, probe.Context.EmittedFiles.Count)
        let generated = probe.Context.EmittedFiles.Where((f EmittedGsFile) -> f.GeneratedSource != nil).ToArray()
        Assert.True(generated.Length >= 2)
        Assert.All(
            generated,
            (file EmittedGsFile) -> {
                Assert.Equal("src/Probe/Probe.csproj", file.GeneratedSource!!.SourceProjectPath)
                Assert.Equal(
                    Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(file.GeneratedSource!!.Text!!))),
                    file.GeneratedSource!!.Sha256
                )
                Assert.StartsWith(authoritative + Path.DirectorySeparatorChar, file.CsFilePath)
                Assert.False(File.Exists(file.CsFilePath))
                Assert.False(file.IsFromReferencedProject)
            }
        )
        AssertNative(probe.Context.EmittedAssemblyPath!!, framework, "Debug")
        Assert.Equal(manifestBytes, File.ReadAllBytes(Path.Combine(artifact, ValidationManifest.FileName)))
        Assert.Equal(1, probe.Context.EmittedFiles.Count((f EmittedGsFile) -> f.GeneratedSource == nil))
        // An existing stale producer must not change replay, either.
        for relative in generatedPaths {
            Write(Path.Combine(producer, relative), "public class Wrong {}")
        }
        let repeated = EvidenceStage()
        let stale = await MigrationPipeline(options, []IMigrationStage{repeated}).ValidateAsync(
            []CorpusApp{app},
            []CorpusApp{app},
            producingRun
        )
        Assert.True(stale.Succeeded)
        Assert.Equal(403, TestParityStage.CountCSharpFactMethods(repeated.Context))
    }

    @Theory
    @InlineData("hash")
    @InlineData("text")
    @InlineData("owner")
    @InlineData("ownership-flag")
    @InlineData("authored-payload")
    @InlineData("owner-escape")
    @InlineData("source-escape")
    @InlineData("missing-payload")
    func Hydrate_GeneratedEvidenceCannotBypassIdentityOrAuthoredSourceChecks(invalid string) {
        let source = Path.Combine(this.root, "source")
        let migrated = Path.Combine(this.root, "migrated")
        Write(Path.Combine(source, "Probe.csproj"), "<Project />")
        Write(Path.Combine(migrated, "obj", "Generated.gs"), "package Probe\n")
        let generated = Path.Combine(source, "obj", "Generated.cs")
        let app = CorpusApp("Probe.csproj", Path.Combine(source, "Probe.csproj"), TargetKind.Library)
        let context = StageExecutionContext(
            app,
            PipelineOptions{SourceRoot: source},
            GscInvoker("unused"),
            migrated,
            TriageBuilder("capture", "ts", "gsc", app.Id)
        )
        context.EmittedFiles.Add(
            EmittedGsFile(Path.Combine(migrated, "obj", "Generated.gs"), "Generated.gs", generated, "package Probe\n"){
                GeneratedSource = GeneratedValidationSource.Capture("public class Generated {}", "Probe.csproj")
            }
        )
        let manifest = ValidationManifest.Capture(context, true, migrated)
        let file = Assert.Single(manifest.EmittedFiles)
        let control = StageExecutionContext(app, context.Options, context.Gsc, migrated, context.Triage)
        manifest.Hydrate(control, migrated)
        Assert.Single(control.EmittedFiles)
        Assert.Equal("public class Generated {}", control.EmittedFiles[0].GeneratedSource!!.Text)
        switch invalid {
            case "hash" {
                file.GeneratedSource!!.Sha256 = String('0', 64)
            }
            case "text" {
                file.GeneratedSource!!.Text = nil
            }
            case "owner" {
                file.GeneratedSource!!.SourceProjectPath = "Other.csproj"
            }
            case "ownership-flag" {
                file.FromReferencedProject = true
            }
            case "authored-payload" {
                file.CsFilePath = Path.Combine(source, "Authored.cs")
                file.RelativeCsPath = "Authored.cs"
            }
            case "owner-escape" {
                file.GeneratedSource!!.SourceProjectPath = "../Probe.csproj"
            }
            case "source-escape" {
                file.CsFilePath = source + "/../obj/Generated.cs"
                file.RelativeCsPath = "../obj/Generated.cs"
            }
            case "missing-payload" {
                file.GeneratedSource = nil
            }
        }
        let hydrate = StageExecutionContext(app, context.Options, context.Gsc, migrated, context.Triage)
        Assert.Throws[InvalidOperationException](() -> manifest.Hydrate(hydrate, migrated))
        Assert.Empty(hydrate.EmittedFiles)
    }

    func Dispose() {
        if Environment.GetEnvironmentVariable("CS2GS_4801_EVIDENCE_ROOT") == nil && Directory.Exists(this.root) {
            Directory.Delete(this.root, recursive: true)
            Console.WriteLine("native fixture root deleted: " + this.root)
        }
    }

    private class EvidenceStage : IMigrationStage {
        prop Kind MigrationStageKind -> MigrationStageKind.TestParity

        internal prop Context StageExecutionContext {
            get;
            private set;
        }

        func ExecuteAsync(
            context StageExecutionContext,
            cancellationToken CancellationToken = default(CancellationToken)
        ) Task[StageOutcome] {
            this.Context = context
            return Task.FromResult(StageOutcome.Skipped())
        }
    }

    shared {
        private func AssertNative(path string, framework string, configuration string) {
            let assembly = EmittedFixture.Load(path)
            Assert.True(assembly.IsCollectible)
            Assert.Empty(assembly.Location)
            Console.WriteLine(
                "native byte-load: " +
                    path +
                    " MVID " +
                    assembly
                    .ManifestModule
                    .ModuleVersionId
                    .ToString() +
                    " SHA256 " +
                    Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
            )
            let target = Assert.Single(
                assembly.GetCustomAttributesData(),
                (a CustomAttributeData) -> a
                    .AttributeType
                    .FullName == "System.Runtime.Versioning.TargetFrameworkAttribute"
            )
            Assert.Equal(framework, target.ConstructorArguments[0].Value)
            Assert.Same(typeof(TargetFrameworkAttribute).Assembly, target.AttributeType.Assembly)
            let configurationAttribute = Assert.Single(
                assembly.GetCustomAttributesData(),
                (a CustomAttributeData) -> a
                    .AttributeType
                    .FullName == "System.Reflection.AssemblyMetadataAttribute" &&
                    a
                    .ConstructorArguments[0]
                    .Value is "ProducerConfiguration"
            )
            Assert.Equal("ProducerConfiguration", configurationAttribute.ConstructorArguments[0].Value)
            Assert.Equal(configuration, configurationAttribute.ConstructorArguments[1].Value)
            let declaration Type? = assembly.GetType("Native.Generated.Declaration", throwOnError: true)
            Assert.Equal(73, declaration!!.GetMethod("Value")!!.Invoke(nil, nil))
            Assert.NotNull(assembly.GetType("Native.Generated.Extra"))
        }

        private func AssertNativeSources(assemblyPath string) {
            using let pdb = File.OpenRead(Path.ChangeExtension(assemblyPath, ".pdb"))
            using let provider = MetadataReaderProvider.FromPortablePdbStream(pdb)
            let reader = provider.GetMetadataReader()
            let documents = reader.Documents.Select(reader.GetDocument).ToArray()
            Assert.NotEmpty(documents)
            let inventory = List[object]()
            for document in documents {
                let path = reader.GetString(document.Name)
                let hash = reader.GetBlobBytes(document.Hash)
                Assert.Equal(SHA256.HashData(File.ReadAllBytes(path)), hash)
                inventory.Add(AnonymousType2_2852AB3CCB00A7ED(path, Convert.ToHexString(hash)))
            }
            Console.WriteLine("native Csc/PDB source inventory: " + JsonSerializer.Serialize(inventory))
        }

        private async func Run(cwd string, command string, args ...string?) {
            let result = await ProcessRunner.RunAsync(command, args, cwd, TimeSpan.FromMinutes(2))
            Console.WriteLine(command + " " + string.Join(" ", args) + "\n" + result.Output)
            Assert.False(result.TimedOut)
            Assert.True(result.ExitCode == 0, result.Output)
        }

        private func Write(path string, text string) {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!!)
            File.WriteAllText(path, text)
        }
    }
}

internal data class AnonymousType2_2852AB3CCB00A7ED(path string, sha256 string) { }
