// <copyright file="Issue2916NestedStructArityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Regression coverage for issue #2916.
class Issue2916NestedStructArityEmitTests {
    @Fact
    func CSharpConsumer_NamesAndRunsNestedStructsByOwnArity() {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2916NestedStructArityEmitTests" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let libraryPath = Path.Combine(directory, "Issue2916.Library.dll")
            let consumerPath = Path.Combine(directory, "Issue2916.Consumer.dll")
            EmitGSharpLibrary(libraryPath)
            EmitCSharpConsumer(libraryPath, consumerPath)
            AssertMetadataNames(libraryPath)
            Assert.Equal(
                "11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}",
                RunConsumer(directory, consumerPath)
            )
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func EmitGSharpLibrary(outputPath string) {
            const source = `package Issue2916

public struct Outer[T any] {
    public struct Inner {
        public var Value int32
    }

    public struct Middle {
        public struct Deep {
            public var Value int32
        }
    }

    public struct GenericInner[U any] {
        public var Value int32
    }
}`
            using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2916.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func EmitCSharpConsumer(libraryPath string, outputPath string) {
            const source = `using System;
using Issue2916;

public static class Program
{
    public static void Main()
    {
        var direct = new Outer<int>.Inner { Value = 11 };
        var throughNonGenericMiddle = new Outer<int>.Middle.Deep { Value = 22 };
        var ownGeneric = new Outer<int>.GenericInner<string> { Value = 33 };

        Console.WriteLine(direct.Value);
        Console.WriteLine(throughNonGenericMiddle.Value);
        Console.WriteLine(ownGeneric.Value);
    }
}`
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .Append(MetadataReference.CreateFromFile(libraryPath))
            let compilation = CSharpCompilation.Create(
                "Issue2916.Consumer",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func AssertMetadataNames(libraryPath string) {
            using let stream = File.OpenRead(libraryPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            AssertType(reader, "Outer`1", genericParameterCount: 1)
            AssertType(reader, "Inner", genericParameterCount: 1)
            AssertType(reader, "Middle", genericParameterCount: 1)
            AssertType(reader, "Deep", genericParameterCount: 1)
            AssertType(reader, "GenericInner`1", genericParameterCount: 2)
        }

        private func AssertType(reader MetadataReader, name string, genericParameterCount int32) {
            let type = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((definition TypeDefinition) -> reader.GetString(definition.Name) == name)
            Assert.Equal(genericParameterCount, type.GetGenericParameters().Count)
        }

        private func RunConsumer(directory string, consumerPath string) string {
            let runtimeConfigPath = Path.ChangeExtension(consumerPath, ".runtimeconfig.json")
            File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(runtimeConfigPath)
            startInfo.ArgumentList.Add(consumerPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start C# consumer")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "C# consumer timed out")
            Assert.True(process.ExitCode == 0, (`C# consumer exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
