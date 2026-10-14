// <copyright file="Issue2550ImportedOptionalDataConstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2550: optional primary-constructor values must survive assembly
/// boundaries so imported data classes and C# records can be constructed with
/// omitted arguments before participating in `with`/`copy`.
open class Issue2550ImportedOptionalDataConstructionTests {
    @Fact
    func Imported_GSharpDataClass_DefaultedConstruction_WithAndCopy_Run() {
        let libraryPath = EmitGSharpLibrary("Imported_GSharpDataClass_DefaultedConstruction_WithAndCopy_Run")
        let output = EmitAndRun(libraryPath, "Issue2550.GSharp", `package Runner
import Models

func Main() {
    let original = Settings()
    let partial = Settings(5)
    let explicit = Settings(6, "explicit")
    let changed = original with { Retries = 8 }
    let copied = original.copy(Label: "copied")
    Console.WriteLine(original.Retries)
    Console.WriteLine(original.Label)
    Console.WriteLine(partial.Retries)
    Console.WriteLine(partial.Label)
    Console.WriteLine(explicit.Retries)
    Console.WriteLine(explicit.Label)
    Console.WriteLine(changed.Retries)
    Console.WriteLine(changed.Label)
    Console.WriteLine(copied.Retries)
    Console.WriteLine(copied.Label)
}`)
        Assert.Equal([]string{"3", "ready", "5", "ready", "6", "explicit", "8", "ready", "3", "copied"}, Lines(output))
    }

    @Fact
    func Imported_CSharpRecord_DefaultedConstruction_WithAndCopy_Run() {
        let libraryPath = EmitCSharpLibrary("Imported_CSharpRecord_DefaultedConstruction_WithAndCopy_Run")
        let output = EmitAndRun(libraryPath, "Issue2550.CSharp", `package Runner
import Models

func Main() {
    let original = Settings()
    let partial = Settings(5)
    let explicit = Settings(6, "explicit")
    let changed = original with { Retries = 8 }
    let copied = original.copy(Label: "copied")
    Console.WriteLine(original.Retries)
    Console.WriteLine(original.Label)
    Console.WriteLine(partial.Retries)
    Console.WriteLine(partial.Label)
    Console.WriteLine(explicit.Retries)
    Console.WriteLine(explicit.Label)
    Console.WriteLine(changed.Retries)
    Console.WriteLine(changed.Label)
    Console.WriteLine(copied.Retries)
    Console.WriteLine(copied.Label)
}`)
        Assert.Equal([]string{"3", "ready", "5", "ready", "6", "explicit", "8", "ready", "3", "copied"}, Lines(output))
    }

    shared {
        private func EmitGSharpLibrary(caseName string) string {
            let libraryPath = LibraryPath(caseName, "Models.dll")
            let library = GsCompilation(GsSyntaxTree.Parse(SourceText.From(`package Models

data class Settings(Retries int32 = 3, Label string = "ready")`))){IsLibrary = true}
            using let stream = File.Create(libraryPath)
            let result = library.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Models")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }

        private func EmitCSharpLibrary(caseName string) string {
            let libraryPath = LibraryPath(caseName, "Models.dll")
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator)
                .Where(File.Exists)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Models",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        "namespace Models; public record Settings(int Retries = 3, string Label = \"ready\");"
                    )
                },
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(libraryPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }

        private func EmitAndRun(libraryPath string, assemblyName string, source string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            resolver.CurrentAssemblyName = assemblyName
            let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            using let stream = MemoryStream()
            let result = consumer.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            stream.Position = 0
            let context = AssemblyLoadContext(assemblyName, isCollectible: true)
            context.Resolving += (loadContext AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                name.Name,
                "Models",
                StringComparison.Ordinal
            ) {
                loadContext.LoadFromAssemblyPath(libraryPath)
            } else {
                default(Assembly?)
            }
            try {
                let assembly = context.LoadFromStream(stream)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    assembly.EntryPoint!!.Invoke(nil, nil)
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                context.Unload()
            }
        }

        private func LibraryPath(caseName string, fileName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2550", caseName)
            Directory.CreateDirectory(directory)
            return Path.Combine(directory, fileName)
        }

        private func Lines(output string)[]string -> output.ReplaceLineEndings(Environment.NewLine).Split(
            Environment.NewLine,
            StringSplitOptions.RemoveEmptyEntries
        )
    }
}
