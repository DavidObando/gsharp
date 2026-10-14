// <copyright file="Issue4802RecursiveHelperActivationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography
import System.Text.Json
import Xunit
import Xunit.Abstractions

@Collection("IlVerifyPipeline")
class Issue4802RecursiveHelperActivationTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("RecursiveHelper", "20,10,0,1,11,21|6|native")
    @InlineData("NestedMutualAndEscapes", "0,1,2|2,1,0")
    @InlineData("OuterMutualThroughNestedBridge", "2,21,1,20,0,10,11,12")
    func NativeAndTranslatedCallbacks_KeepTheirDeclaringActivation(method string, expected string) {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue4802", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            this.output.WriteLine(
                "Active translator: " +
                    typeof(CSharpToGSharpTranslator)
                    .Assembly
                    .Location +
                    " SHA256=" +
                    Convert.ToHexString(
                    SHA256.HashData(File.ReadAllBytes(typeof(CSharpToGSharpTranslator).Assembly.Location))
                )
            )
            let source = File.ReadAllText(
                Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue4802", "Activation.cs.txt")
            )
            let nativeSource = Path.Combine(directory, "Activation.cs")
            File.WriteAllText(nativeSource, source)
            let projectPath = Path.Combine(directory, "Native.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <DebugType>portable</DebugType>
    <Deterministic>true</Deterministic>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
  </PropertyGroup>
  <ItemGroup><Compile Include="Activation.cs" /></ItemGroup>
</Project>`)
            let intermediate = "/p:BaseIntermediateOutputPath=" + Path.Combine(directory, "obj") +
                Path.DirectorySeparatorChar
            this.Run(
                directory,
                "native-restore",
                []string{
                    "restore",
                    projectPath,
                    "--locked-mode",
                    "/nr:false",
                    intermediate,
                    "/p:ImportDirectoryBuildProps=false",
                    "/p:ImportDirectoryBuildTargets=false"
                }
            )
            this.Run(
                directory,
                "native-build",
                []string{
                    "build",
                    projectPath,
                    "-c",
                    "Release",
                    "--no-restore",
                    "-graph",
                    "/nr:false",
                    "/bl:" + Path.Combine(directory, "native.binlog"),
                    "/p:ImportDirectoryBuildProps=false",
                    "/p:ImportDirectoryBuildTargets=false",
                    intermediate,
                    "/p:OutputPath=" + Path.Combine(directory, "native") + Path.DirectorySeparatorChar
                }
            )
            let nativeImage = Path.Combine(directory, "native", "Native.dll")
            this.AssertContract(nativeImage, method, expected)
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Activation.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let translatedSource = Path.Combine(directory, "Activation.gs")
            File.WriteAllText(translatedSource, printed)
            let translatedImage = Path.Combine(directory, "Translated.dll")
            let compiler string? = LocalFunctionHoistTranslationTests.FindCompiler()
            Assert.NotNull(compiler)
            this.Run(
                directory,
                "gsc",
                []string{compiler!!, "/target:library", "/out:" + translatedImage, translatedSource}
            )
            for image in[]string{nativeImage, translatedImage} {
                let verify = List[string]{"tool", "run", "ilverify", image, "-s", "System.Private.CoreLib"}
                for reference in Directory.EnumerateFiles(
                    Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                    "*.dll"
                ) {
                    verify.Add("-r")
                    verify.Add(reference)
                }
                this.Run(directory, Path.GetFileNameWithoutExtension(image) + "-strict-ilverify", verify)
            }
            this.AssertContract(translatedImage, method, expected)
        } finally {
            CaptureEvidenceAndCleanup(directory, Environment.GetEnvironmentVariable("GSHARP_ISSUE4802_EVIDENCE"))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func EvidenceCapture_UsesSuppliedRootPreservesArtifactsAndCleansWorkspace(fixtureFails bool) {
        let root = Path.Combine(AppContext.BaseDirectory, "issue4802-evidence", Guid.NewGuid().ToString("N"))
        let directory = Path.Combine(root, "workspace")
        let evidence = Path.Combine(root, "supplied evidence")
        let destination = Path.Combine(evidence, "workspace")
        Directory.CreateDirectory(Path.Combine(directory, "native"))
        Directory.CreateDirectory(destination)
        try {
            File.WriteAllText(Path.Combine(directory, "command.log"), "fixture evidence")
            let product[]uint8 = []uint8{0, 1, 255, 42}
            File.WriteAllBytes(Path.Combine(directory, "native", "Native.pdb"), product)
            File.WriteAllText(Path.Combine(evidence, "existing.marker"), "root artifact")
            File.WriteAllText(Path.Combine(destination, "existing.log"), "previous artifact")
            let failure = Record.Exception(
                () -> {
                    try {
                        if fixtureFails {
                            throw InvalidOperationException("original fixture failure")
                        }
                    } finally {
                        CaptureEvidenceAndCleanup(directory, evidence)
                    }
                }
            )
            if fixtureFails {
                Assert.Equal("original fixture failure", Assert.IsType[InvalidOperationException](failure).Message)
            } else {
                Assert.Null(failure)
            }
            Assert.False(Directory.Exists(directory))
            Assert.Equal("fixture evidence", File.ReadAllText(Path.Combine(destination, "command.log")))
            Assert.Equal(product, File.ReadAllBytes(Path.Combine(destination, "native", "Native.pdb")))
            Assert.Equal("root artifact", File.ReadAllText(Path.Combine(evidence, "existing.marker")))
            Assert.Equal("previous artifact", File.ReadAllText(Path.Combine(destination, "existing.log")))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func EvidenceCapture_CleansWorkspaceAndReportsCopyFailure() {
        let root = Path.Combine(AppContext.BaseDirectory, "issue4802-evidence", Guid.NewGuid().ToString("N"))
        let directory = Path.Combine(root, "workspace")
        let evidence = Path.Combine(root, "blocked evidence")
        Directory.CreateDirectory(directory)
        try {
            File.WriteAllText(Path.Combine(directory, "command.log"), "fixture evidence")
            File.WriteAllText(evidence, "existing artifact")
            Assert.ThrowsAny[IOException](() -> CaptureEvidenceAndCleanup(directory, evidence))
            Assert.False(Directory.Exists(directory))
            Assert.Equal("existing artifact", File.ReadAllText(evidence))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(nil)
    @InlineData("")
    func EvidenceCapture_WithoutDestinationStillCleansWorkspace(evidence string?) {
        let root = Path.Combine(AppContext.BaseDirectory, "issue4802-evidence", Guid.NewGuid().ToString("N"))
        let directory = Path.Combine(root, "workspace")
        Directory.CreateDirectory(directory)
        try {
            File.WriteAllText(Path.Combine(directory, "command.log"), "fixture evidence")
            CaptureEvidenceAndCleanup(directory, evidence)
            Assert.False(Directory.Exists(directory))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    private func AssertContract(image string, method string, expected string) {
        let assembly = EmittedFixture.Load(image)
        let definition Type? = assembly.GetType("Issue4802.Activation`1")
        Assert.NotNull(definition)
        let type = definition!!.MakeGenericType(typeof(string))
        let instance object? = Activator.CreateInstance(type, "native")
        Assert.NotNull(instance)
        let callback MethodInfo? = type.GetMethod(method)
        Assert.NotNull(callback)
        let actual = Assert.IsType[string](callback!!.Invoke(instance, nil))
        this.output.WriteLine(Path.GetFileName(image) + " " + method + ": " + actual)
        Assert.Equal(expected, actual)
    }

    private func Run(directory string, label string, arguments IEnumerable[string]) {
        let command = arguments.ToArray()
        File.WriteAllText(Path.Combine(directory, label + ".command.json"), JsonSerializer.Serialize(command))
        let result = ProcessRunner.Run("dotnet", command, GsharpTestProjectRunner.FindRepoRoot())
        File.WriteAllText(Path.Combine(directory, label + ".log"), result.Output)
        File.WriteAllText(Path.Combine(directory, label + ".exit"), result.ExitCode.ToString())
        this.output.WriteLine(label + ": " + result.Output)
        Assert.False(result.TimedOut, result.Output)
        Assert.True(result.ExitCode == 0, result.Output)
    }

    shared {
        private func CaptureEvidenceAndCleanup(directory string, evidence string?) {
            try {
                if !string.IsNullOrEmpty(evidence) {
                    let destination = Path.Combine(evidence, Path.GetFileName(directory))
                    Directory.CreateDirectory(destination)
                    for file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories) {
                        let target = Path.Combine(destination, Path.GetRelativePath(directory, file))
                        Directory.CreateDirectory(Path.GetDirectoryName(target)!!)
                        File.Copy(file, target, overwrite: true)
                    }
                }
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
