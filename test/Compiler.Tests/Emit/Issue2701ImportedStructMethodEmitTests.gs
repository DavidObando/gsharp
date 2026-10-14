// <copyright file="Issue2701ImportedStructMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

class Issue2701ImportedStructMethodEmitTests {
    @Fact
    func ExactOahuIconRender_CrossAssembly_RunsVerifiesAndReferencesExactMethod() {
        using let artifacts = Compile(OahuSource)
        Assert.DoesNotContain("GS9998", artifacts.Diagnostics, StringComparison.Ordinal)
        Assert.Equal("icon:on${Environment.NewLine}", Run(artifacts.OutputPath))
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: []string{artifacts.FixturePath})
        using let stream = File.OpenRead(artifacts.OutputPath)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let renderHandle = Assert.Single(
            reader.MemberReferences,
            (handle MemberReferenceHandle) -> reader.GetString(reader.GetMemberReference(handle).Name) == "Render"
        )
        let render = reader.GetMemberReference(renderHandle)
        let parent = reader.GetTypeReference(TypeReferenceHandle(render.Parent))
        Assert.Equal("Oahu.Cli", reader.GetString(parent.Namespace))
        Assert.Equal("Icon", reader.GetString(parent.Name))
        Assert.Equal([]uint8{0x20, 0x01, 0x0E, 0x02}, reader.GetBlobBytes(render.Signature))
    }

    @Fact
    func IconRender_WithWrongArgument_RemainsACompileTimeError() {
        let source = OahuSource.Replace("Render(true)", "Render(1)", StringComparison.Ordinal)
        using let artifacts = Compile(source, expectSuccess: false)
        Assert.NotEqual(0, artifacts.ExitCode)
        Assert.Contains("GS0159", artifacts.Diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", artifacts.Diagnostics, StringComparison.Ordinal)
    }

    private class CompilationArtifacts : IDisposable {
        init(directory string, fixturePath string, outputPath string, exitCode int32, diagnostics string) {
            Directory = directory
            FixturePath = fixturePath
            OutputPath = outputPath
            ExitCode = exitCode
            Diagnostics = diagnostics
        }

        prop Directory string {
            get;
        }

        prop FixturePath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ExitCode int32 {
            get;
        }

        prop Diagnostics string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private const FixtureSource string = `namespace Oahu.Cli;

public readonly struct Icon
{
    public string Render(bool enabled) => enabled ? "icon:on" : "icon:off";
}`

        private const OahuSource string = `package Oahu.Cli.App

import System
import Oahu.Cli

func Main() {
    var icon = Icon()
    Console.WriteLine(icon.Render(true))
}`

        private func Compile(source string, expectSuccess bool = true) Issue2701ImportedStructMethodEmitTests
            .CompilationArtifacts {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2701-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let fixturePath = Path.Combine(directory, "Oahu.Cli.dll")
            EmitFixture(fixturePath)
            let sourcePath = Path.Combine(directory, "Program.gs")
            let outputPath = Path.Combine(directory, "Oahu.Cli.App.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{
                        "/out:" + outputPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + fixturePath,
                        sourcePath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            let diagnostics = stdout.ToString() + stderr.ToString()
            if expectSuccess {
                Assert.True(exitCode == 0, (`gsc failed:
` + "$diagnostics"))
            }
            return Issue2701ImportedStructMethodEmitTests.CompilationArtifacts(
                directory,
                fixturePath,
                outputPath,
                exitCode,
                diagnostics
            )
        }

        private func EmitFixture(path string) {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
                .Select((reference string) -> MetadataReference.CreateFromFile(reference))
            let compilation = CSharpCompilation.Create(
                "Oahu.Cli",
                []SyntaxTree{CSharpSyntaxTree.ParseText(FixtureSource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(path)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo)!!
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
