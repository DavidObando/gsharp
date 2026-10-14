// <copyright file="ImportedExtensionDeclaringAssemblyInvariantEmitTests.cs" company="GSharp">
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

/// Verifies that an imported extension method's MemberRef retains its
/// (cref:System.Reflection.MethodInfo.DeclaringType) assembly identity
/// when another reference defines the same fully-qualified host type.
class ImportedExtensionDeclaringAssemblyInvariantEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func MemberRef_PreservesDeclaringAssembly_RegardlessOfReferenceOrder(shadowReferenceFirst bool) {
        using let artifacts = Compile(shadowReferenceFirst)
        IlVerifier.Verify(
            artifacts.OutputPath,
            additionalReferences: []string{artifacts.PrimaryPath, artifacts.ShadowPath}
        )
        using let stream = File.OpenRead(artifacts.OutputPath)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let callHandle = Assert.Single(
            reader.MemberReferences,
            (handle MemberReferenceHandle) -> reader.GetString(reader.GetMemberReference(handle).Name) == "Call"
        )
        let call = reader.GetMemberReference(callHandle)
        Assert.Equal(HandleKind.TypeReference, call.Parent.Kind)
        let parent = reader.GetTypeReference(TypeReferenceHandle(call.Parent))
        Assert.Equal(HandleKind.AssemblyReference, parent.ResolutionScope.Kind)
        let assembly = reader.GetAssemblyReference(AssemblyReferenceHandle(parent.ResolutionScope))
        Assert.Equal("ClassLibrary1", reader.GetString(assembly.Name))
        Assert.Equal("correct${Environment.NewLine}", Run(artifacts.OutputPath))
    }

    private class CompilationArtifacts : IDisposable {
        init(directory string, primaryPath string, shadowPath string, outputPath string) {
            Directory = directory
            PrimaryPath = primaryPath
            ShadowPath = shadowPath
            OutputPath = outputPath
        }

        prop Directory string {
            get;
        }

        prop PrimaryPath string {
            get;
        }

        prop ShadowPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private const PrimarySource string = `namespace ClassLibrary1;

public sealed class A { }

public static class B
{
    public static string Call(this A value) => "correct";
}`

        private const ShadowSource string = `namespace ClassLibrary1;

public static class B
{
    public static string Shadow(this A value) => "shadow";
}`

        private const GSharpSource string = `package MyApp

import System
import ClassLibrary1

var a = A()
Console.WriteLine(a.Call())`

        private func Compile(shadowReferenceFirst bool) ImportedExtensionDeclaringAssemblyInvariantEmitTests
            .CompilationArtifacts {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "imported-extension-assembly-identity-artifacts",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            let primaryPath = Path.Combine(directory, "ClassLibrary1.dll")
            EmitFixture("ClassLibrary1", PrimarySource, primaryPath)
            let shadowPath = Path.Combine(directory, "AClassLibrary3.dll")
            EmitFixture(
                "AClassLibrary3",
                ShadowSource,
                shadowPath,
                cast[[]MetadataReference]([]PortableExecutableReference{MetadataReference.CreateFromFile(primaryPath)})
            )
            let sourcePath = Path.Combine(directory, "Program.gs")
            let outputPath = Path.Combine(directory, "MyApp.dll")
            File.WriteAllText(sourcePath, GSharpSource)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                let firstReference = if shadowReferenceFirst {
                    shadowPath
                } else {
                    primaryPath
                }
                let secondReference = if shadowReferenceFirst {
                    primaryPath
                } else {
                    shadowPath
                }
                exitCode = Program.Main(
                    []string{
                        "/out:" + outputPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + firstReference,
                        "/reference:" + secondReference,
                        sourcePath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            let diagnostics = stdout.ToString() + stderr.ToString()
            Assert.True(exitCode == 0, (`gsc failed:
` + "$diagnostics"))
            return ImportedExtensionDeclaringAssemblyInvariantEmitTests.CompilationArtifacts(
                directory,
                primaryPath,
                shadowPath,
                outputPath
            )
        }

        private func EmitFixture(
            assemblyName string,
            source string,
            path string,
            additionalReferences[]?MetadataReference = nil
        ) {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Select((reference string) -> MetadataReference.CreateFromFile(reference))
                .Concat(additionalReferences ?? Array.Empty[MetadataReference]())
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
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
