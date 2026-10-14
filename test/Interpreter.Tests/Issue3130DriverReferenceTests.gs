// <copyright file="Issue3130DriverReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Repl
import GSharp.Repl.Engine
import GSharp.Tests
import System
import System.IO
import System.Reflection
import System.Reflection.Emit
import System.Threading.Tasks
import Xunit

/// Issue #3130: real evaluating drivers resolve bundled and explicit references.
class Issue3130DriverReferenceTests {
    @Fact
    async func ExtensionSamples_MatchEmitAcrossRealDrivers() {
        let samplesDirectory = LocateSamplesDirectory()
        let gscPath = typeof(GSharp.Compiler.Program).Assembly.Location
        let gsiPath = typeof(GSharp.Repl.Program).Assembly.Location
        let extensionsPath = Path.Combine(Path.GetDirectoryName(gsiPath)!!, "Gsharp.Extensions.dll")
        Assert.True(File.Exists(extensionsPath), "Missing $extensionsPath")
        for sample in ExtensionSamples {
            let directory = CreateEmptyTestDirectory(sample)
            try {
                let sourcePath = Path.Combine(directory, sample + ".gs")
                let outputPath = Path.Combine(directory, sample + ".dll")
                File.Copy(Path.Combine(samplesDirectory, sample + ".gs"), sourcePath)
                let expected = Normalize(File.ReadAllText(Path.Combine(samplesDirectory, sample + ".golden")))
                let emit = await RunAsync(
                    directory,
                    gscPath,
                    "/nowarn:GS9100",
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/out:" + outputPath,
                    sourcePath
                )
                AssertSucceeded(emit, sample + " emit")
                CollectibleAssembly.Inspect(outputPath, (assembly Assembly) -> Assert.NotEmpty(assembly.GetTypes()))
                File.Copy(extensionsPath, Path.Combine(directory, "Gsharp.Extensions.dll"), overwrite: true)
                let emitted = await RunAsync(
                    directory,
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                    outputPath
                )
                AssertSucceeded(emitted, sample + " emitted execution")
                Assert.Equal(expected, Normalize(emitted.StandardOutput))
                let bareGsc = await RunAsync(directory, gscPath, "/nowarn:GS9100", sourcePath)
                AssertSucceeded(bareGsc, sample + " bare gsc")
                Assert.Equal(expected + "Success.${Environment.NewLine}", Normalize(bareGsc.StandardOutput))
                let gsi = await RunAsync(directory, gsiPath, sourcePath)
                AssertSucceeded(gsi, sample + " gsi")
                Assert.Equal(expected, Normalize(gsi.StandardOutput))
            } finally {
                DeleteDirectory(directory)
            }
        }
    }

    @Fact
    async func FullyQualifiedExtensionUse_MatchesEmitAcrossRealDrivers() {
        let directory = CreateEmptyTestDirectory("fully-qualified")
        try {
            let gscPath = typeof(GSharp.Compiler.Program).Assembly.Location
            let gsiPath = typeof(GSharp.Repl.Program).Assembly.Location
            let extensionsPath = Path.Combine(Path.GetDirectoryName(gsiPath)!!, "Gsharp.Extensions.dll")
            let sourcePath = Path.Combine(directory, "probe.gs")
            let outputPath = Path.Combine(directory, "probe.dll")
            File.WriteAllText(sourcePath, `package FullyQualifiedProbe
import System

let values = Gsharp.Extensions.Sequences.Sequences.Of(11, 22, 33)
Console.WriteLine(values[0])`)
            let emit = await RunAsync(
                directory,
                gscPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + outputPath,
                sourcePath
            )
            AssertSucceeded(emit, "fully-qualified emit")
            File.Copy(extensionsPath, Path.Combine(directory, "Gsharp.Extensions.dll"), overwrite: true)
            let emitted = await RunAsync(
                directory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath
            )
            AssertSucceeded(emitted, "fully-qualified emitted execution")
            Assert.Equal("11${Environment.NewLine}", Normalize(emitted.StandardOutput))
            let bareGsc = await RunAsync(directory, gscPath, sourcePath)
            AssertSucceeded(bareGsc, "fully-qualified bare gsc")
            Assert.Equal("11${Environment.NewLine}Success.${Environment.NewLine}", Normalize(bareGsc.StandardOutput))
            let gsi = await RunAsync(directory, gsiPath, sourcePath)
            AssertSucceeded(gsi, "fully-qualified gsi")
            Assert.Equal("11${Environment.NewLine}", Normalize(gsi.StandardOutput))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    async func ExplicitReference_WorksAcrossRealDrivers() {
        let directory = CreateEmptyTestDirectory("explicit")
        try {
            let gscPath = typeof(GSharp.Compiler.Program).Assembly.Location
            let gsiPath = typeof(GSharp.Repl.Program).Assembly.Location
            let referencePath = Path.Combine(directory, "ExternalProbe.dll")
            let sourcePath = Path.Combine(directory, "probe.gs")
            let outputPath = Path.Combine(directory, "probe.dll")
            EmitProbeAssembly(referencePath)
            File.WriteAllText(sourcePath, `package ReferenceProbe
import System
import ExternalProbe

Console.WriteLine(Values.Answer())`)
            let bareWithoutReference = await RunAsync(directory, gscPath, sourcePath)
            Assert.NotEqual(0, bareWithoutReference.ExitCode)
            Assert.Contains("error GS", bareWithoutReference.Combined)
            let gsiWithoutReference = await RunAsync(directory, gsiPath, sourcePath)
            Assert.NotEqual(0, gsiWithoutReference.ExitCode)
            Assert.Contains("error GS", gsiWithoutReference.Combined)
            let emit = await RunAsync(
                directory,
                gscPath,
                "/nowarn:GS9100",
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + outputPath,
                "/r:" + referencePath,
                sourcePath
            )
            AssertSucceeded(emit, "explicit-reference emit")
            let emitted = await RunAsync(
                directory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath
            )
            AssertSucceeded(emitted, "explicit-reference emitted execution")
            Assert.Equal("42${Environment.NewLine}", Normalize(emitted.StandardOutput))
            let bareGsc = await RunAsync(directory, gscPath, "/nowarn:GS9100", "/r:" + referencePath, sourcePath)
            AssertSucceeded(bareGsc, "explicit-reference bare gsc")
            Assert.Equal("42${Environment.NewLine}Success.${Environment.NewLine}", Normalize(bareGsc.StandardOutput))
            let gsi = await RunAsync(directory, gsiPath, "/r:" + referencePath, sourcePath)
            AssertSucceeded(gsi, "explicit-reference gsi")
            Assert.Equal("42${Environment.NewLine}", Normalize(gsi.StandardOutput))
            let help = await RunAsync(directory, gsiPath, "--help")
            AssertSucceeded(help, "gsi help")
            Assert.Contains("/r:<file>", help.StandardOutput)
            let misplacedHelp = await RunAsync(directory, gsiPath, sourcePath, "--help")
            Assert.NotEqual(0, misplacedHelp.ExitCode)
            Assert.Contains("Unrecognized argument: --help", misplacedHelp.StandardError)
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    func GsiRuntimeManifest_IncludesExtensionsAssembly() {
        let gsiPath = typeof(GSharp.Repl.Program).Assembly.Location
        let dependenciesPath = Path.ChangeExtension(gsiPath, ".deps.json")
        Assert.Contains("Gsharp.Extensions", File.ReadAllText(dependenciesPath))
    }

    @Fact
    async func UnrelatedEmit_DoesNotAcquireImplicitExtensionWarnings() {
        let directory = CreateEmptyTestDirectory("unrelated-emit")
        try {
            let sourcePath = Path.Combine(directory, "probe.gs")
            File.WriteAllText(sourcePath, "import System\nConsole.WriteLine(42)")
            let result = await RunAsync(
                directory,
                typeof(GSharp.Compiler.Program).Assembly.Location,
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + Path.Combine(directory, "probe.dll"),
                sourcePath
            )
            AssertSucceeded(result, "unrelated emit")
            Assert.DoesNotContain("GS9100", result.Combined)
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    async func BundledExtensionEmit_UsesInvokableRuntimeTypes() {
        let directory = CreateEmptyTestDirectory("runtime-emit")
        try {
            let gsiPath = typeof(GSharp.Repl.Program).Assembly.Location
            let extensionsPath = Path.Combine(Path.GetDirectoryName(gsiPath)!!, "Gsharp.Extensions.dll")
            let sourcePath = Path.Combine(directory, "probe.gs")
            let outputPath = Path.Combine(directory, "probe.dll")
            File.WriteAllText(sourcePath, `package RuntimeEmitProbe
import System

let values = chan[DateTime](1)
values <- DateTime(2020, 1, 1)
Console.WriteLine((<-values).Year)`)
            let emit = await RunAsync(
                directory,
                typeof(GSharp.Compiler.Program).Assembly.Location,
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + outputPath,
                sourcePath
            )
            AssertSucceeded(emit, "runtime extension emit")
            File.Copy(extensionsPath, Path.Combine(directory, "Gsharp.Extensions.dll"), overwrite: true)
            let emitted = await RunAsync(
                directory,
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath
            )
            AssertSucceeded(emitted, "runtime extension execution")
            Assert.Equal("2020${Environment.NewLine}", Normalize(emitted.StandardOutput))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    async func BadReferences_AreRejectedAcrossRealDrivers() {
        for kind in[]string{"missing", "junk"} {
            let directory = CreateEmptyTestDirectory("bad-" + kind)
            try {
                let gscPath = typeof(GSharp.Compiler.Program).Assembly.Location
                let gsiPath = typeof(GSharp.Repl.Program).Assembly.Location
                let sourcePath = Path.Combine(directory, "probe.gs")
                let referencePath = Path.Combine(directory, kind + ".dll")
                File.WriteAllText(sourcePath, "import System\nConsole.WriteLine(42)")
                if kind == "junk" {
                    File.WriteAllText(referencePath, "not an assembly")
                }
                let referenceArgument = "/r:" + referencePath
                AssertRejectedReference(
                    await RunAsync(directory, gscPath, referenceArgument, sourcePath),
                    referencePath,
                    "bare gsc " + kind
                )
                AssertRejectedReference(
                    await RunAsync(
                        directory,
                        gscPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/out:" + Path.Combine(directory, "probe.dll"),
                        referenceArgument,
                        sourcePath
                    ),
                    referencePath,
                    "emit " + kind
                )
                AssertRejectedReference(
                    await RunAsync(directory, gsiPath, referenceArgument, sourcePath),
                    referencePath,
                    "gsi " + kind
                )
            } finally {
                DeleteDirectory(directory)
            }
        }
    }

    @Fact
    func BundledExtensionProbe_PrefersDriverSiblingThenBuildThenSdkLayout() {
        let directory = CreateEmptyTestDirectory("layouts")
        try {
            let driverDirectory = Path.Combine(directory, "compiler")
            let driverSibling = Path.Combine(driverDirectory, "Gsharp.Extensions.dll")
            let buildSibling = Path.Combine(directory, "Gsharp.Extensions", "Gsharp.Extensions.dll")
            let sdkSibling = Path.Combine(directory, "extensions", "Gsharp.Extensions.dll")
            Directory.CreateDirectory(driverDirectory)
            Directory.CreateDirectory(Path.GetDirectoryName(buildSibling)!!)
            Directory.CreateDirectory(Path.GetDirectoryName(sdkSibling)!!)
            File.WriteAllText(driverSibling, string.Empty)
            File.WriteAllText(buildSibling, string.Empty)
            File.WriteAllText(sdkSibling, string.Empty)
            Assert.Equal(driverSibling, ReferenceResolver.FindBundledExtensionPath(driverDirectory))
            File.Delete(driverSibling)
            Assert.Equal(buildSibling, ReferenceResolver.FindBundledExtensionPath(driverDirectory))
            File.Delete(buildSibling)
            Assert.Equal(sdkSibling, ReferenceResolver.FindBundledExtensionPath(driverDirectory))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    func RuntimeReferenceResolver_DoesNotSilenceInvalidReferences() {
        let directory = CreateEmptyTestDirectory("runtime-invalid")
        try {
            let missingPath = Path.Combine(directory, "missing.dll")
            let junkPath = Path.Combine(directory, "junk.dll")
            File.WriteAllText(junkPath, "not an assembly")
            Assert.Throws[FileNotFoundException](
                func () object? {
                    return ReferenceResolver.WithRuntimeReferences([]string{missingPath})
                }
            )
            Assert.Throws[BadImageFormatException](
                func () object? {
                    return ReferenceResolver.WithRuntimeReferences([]string{junkPath})
                }
            )
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    func RuntimeReferenceResolver_DoesNotLeakExplicitReferences() {
        let directory = CreateEmptyTestDirectory("runtime-isolation")
        try {
            let referencePath = Path.Combine(directory, "ExternalProbe.dll")
            EmitProbeAssembly(referencePath)
            {
                using let referenced = ReferenceResolver.WithRuntimeReferences([]string{referencePath})
                Assert.True(referenced.TryResolveType("ExternalProbe.Values", out _))
            }
            using let clean = ReferenceResolver.WithRuntimeReferences([]string{})
            Assert.False(clean.TryResolveType("ExternalProbe.Values", out _))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    func SessionEngine_UsesProvidedRuntimeReferences() {
        // ADR-0156 Phase 3c (#3176): the interactive /r: channel now belongs
        // to the emitted engine; same probe, same reference path contract.
        let directory = CreateEmptyTestDirectory("session-reference")
        try {
            let referencePath = Path.Combine(directory, "ExternalProbe.dll")
            EmitProbeAssembly(referencePath)
            using let engine = EmittedSessionEngine([]string{referencePath})
            let cell = engine.Evaluate(`package SessionReference
import ExternalProbe
var answer = Values.Answer()`)
            Assert.False(cell.HasError, string.Join(Environment.NewLine, cell.Diagnostics))
        } finally {
            DeleteDirectory(directory)
        }
    }

    shared {
        private let ExtensionSamples[]string = []string{
            "GsharpExtensionsOptional",
            "GsharpExtensionsMixed",
            "GsharpExtensionsSequences"
        }

        private func EmitProbeAssembly(outputPath string) {
            let builder = PersistedAssemblyBuilder(AssemblyName("ExternalProbe"), typeof(object).Assembly)
            let module = builder.DefineDynamicModule("ExternalProbe")
            let type = module.DefineType(
                "ExternalProbe.Values",
                TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed
            )
            let answer = type.DefineMethod(
                "Answer",
                MethodAttributes.Public | MethodAttributes.Static,
                typeof(int32),
                Type.EmptyTypes
            )
            let il = answer.GetILGenerator()
            il.Emit(OpCodes.Ldc_I4, 42)
            il.Emit(OpCodes.Ret)
            type.CreateType()
            builder.Save(outputPath)
        }

        private func RunAsync(workingDirectory string, arguments ...string) Task[
            DotnetProcessResult
        ] -> DotnetProcess.RunAsync(workingDirectory, arguments)

        private func AssertSucceeded(result DotnetProcessResult, operation string) -> Assert.True(
            result.ExitCode == 0,
            ("$operation" + ` exited ` + "${result.ExitCode}" + `
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}")
        )

        private func AssertRejectedReference(result DotnetProcessResult, referencePath string, operation string) {
            Assert.True(result.ExitCode != 0, "$operation unexpectedly succeeded")
            Assert.Contains("Unable to load reference", result.Combined)
            Assert.Contains(referencePath, result.Combined)
        }

        private func LocateSamplesDirectory() string {
            for var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory);
                directory != nil;
                directory = directory!!
                .Parent {
                let candidate = Path.Combine(directory.FullName, "samples")
                if Directory.Exists(candidate) && RepositoryRootMarker.IsRoot(directory.FullName) {
                    return candidate
                }
            }
            throw DirectoryNotFoundException("Unable to locate samples directory")
        }

        private func CreateEmptyTestDirectory(suffix string) string {
            let root = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3130DriverReferenceTests",
                suffix + "-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(root)
            Assert.Empty(Directory.GetFileSystemEntries(root))
            return root
        }

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }

        private func Normalize(text string) string -> text.ReplaceLineEndings(Environment.NewLine)
    }
}
