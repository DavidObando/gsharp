// <copyright file="Issue2291ImportedRecordWithCopyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.Loader
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis.Emit
import System.Reflection

/// Issue #2291: an externally-referenced assembly that is a genuine C#
/// `record`/`record struct` but was compiled by the C# compiler
/// (not gsc) never carries the `GSharp.TypeSemantics` assembly-metadata
/// marker gsc writes for its own data classes/structs. Without a fallback,
/// gsc cannot recognize the type as a data class, so `x with { ... }` /
/// `copy` on it fails GS0161 even though it is a real record.
/// (cref:ImportedAssemblySemantics.TryDetectCSharpRecordSemantics) now
/// recognizes the compiler-emitted record SHAPE — `PrintMembers` plus a
/// copy constructor for both a `record class` and a `record struct`,
/// plus `<Clone>$`/`EqualityContract` additionally required
/// for a `record class` — as a fallback data-class marker, generalized to
/// both record kinds. A plain (non-record) imported class/struct still fails
/// GS0161 (negative control).
open class Issue2291ImportedRecordWithCopyTests {
    @Fact
    func Imported_CSharpRecordClass_With_Compiles() {
        let libraryPath = EmitCSharpLibrary(
            "Imported_CSharpRecordClass_With_Compiles",
            "namespace Records { public record Person(string Name, int Age); }"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import Records

func Run() int32 {
    let p = Person("Ada", 30)
    let p2 = p with { Age = 5 }
    return p2.Age
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_CSharpRecordStruct_With_Compiles() {
        let libraryPath = EmitCSharpLibrary(
            "Imported_CSharpRecordStruct_With_Compiles",
            "namespace Records { public record struct Point(int X, int Y); }"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import Records

func Run() int32 {
    let p = Point(1, 2)
    let p2 = p with { X = 9 }
    return p2.X + p2.Y
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_CSharpRecordClass_Copy_Compiles() {
        let libraryPath = EmitCSharpLibrary(
            "Imported_CSharpRecordClass_Copy_Compiles",
            "namespace Records { public record Person(string Name, int Age); }"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import Records

func Run() int32 {
    let p = Person("Ada", 30)
    let p2 = p.copy(Age: 5)
    return p2.Age
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_CSharpRecordClass_FromStaticProperty_With_Compiles() {
        let libraryPath = EmitCSharpLibrary("Imported_CSharpRecordClass_FromStaticProperty_With_Compiles", `#nullable enable
namespace Records
{
    public record Person(string Name, int Age)
    {
        public static Person Default => new("Ada", 30);
    }
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import Records

func Run() int32 {
    let p = Person.Default
    let p2 = p with { Age = 5 }
    return p2.Age
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_SealedCSharpRecord_QualifiedTypeClause_With_Runs() {
        let referencePath = EmitCSharpReferenceLibrary("Imported_SealedCSharpRecord_QualifiedTypeClause_With_Runs", `namespace Records
{
    public sealed record Settings
    {
        public string Label { get; init; } = "ready";
        public int Retries { get; init; } = 3;
    }
}`, out var libraryPath)
        using let resolver = ReferenceResolver.WithReferences([]string{referencePath})
        resolver.CurrentAssemblyName = "Consumer"
        Assert.True(resolver.TryResolveType("Records.Settings", out var reflected))
        Assert.True(ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(reflected, out _))
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer

func Change(value Records.Settings) Records.Settings ->
    value with { Label = "copied", Retries = 8 }

func Main() {
    let original = Records.Settings()
    let changed = Change(original)
    Console.WriteLine(original.Label)
    Console.WriteLine(original.Retries)
    Console.WriteLine(changed.Label)
    Console.WriteLine(changed.Retries)
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("Issue2551-QualifiedRecord", isCollectible: true)
        loadContext.Resolving += (context AssemblyLoadContext, name AssemblyName) -> if string.Equals(
            name.Name,
            "CSharpLib2291",
            StringComparison.Ordinal
        ) {
            context.LoadFromAssemblyPath(libraryPath)
        } else {
            default(Assembly?)
        }
        try {
            let assembly = loadContext.LoadFromStream(peStream)
            let stdout = Console.Out
            using let captured = StringWriter()
            Console.SetOut(captured)
            try {
                assembly.EntryPoint!!.Invoke(nil, nil)
            } finally {
                Console.SetOut(stdout)
            }
            Assert.Equal(
                "ready${Environment.NewLine}3${Environment.NewLine}copied${Environment.NewLine}8${Environment.NewLine}",
                captured.ToString().ReplaceLineEndings(Environment.NewLine)
            )
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func Imported_PlainCSharpClass_With_StillReportsGs0161() {
        let libraryPath = EmitCSharpLibrary(
            "Imported_PlainCSharpClass_With_StillReportsGs0161",
            "namespace Records { public class PlainPerson { public string Name { get; set; } public int Age { get; set; } } }"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import Records

func Run() int32 {
    let p = PlainPerson()
    let p2 = p with { Age = 5 }
    return p2.Age
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0161")
    }

    shared {
        private func EmitCSharpLibrary(caseName string, recordSource string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2291", caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "CSharpLib2291.dll")
            let compilation = CreateCSharpCompilation(recordSource)
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }

        private func EmitCSharpReferenceLibrary(
            caseName string,
            recordSource string,
            out implementationPath string
        ) string {
            implementationPath = EmitCSharpLibrary(caseName, recordSource)
            let referencePath = Path.Combine(Path.GetDirectoryName(implementationPath)!!, "CSharpLib2291.ref.dll")
            let compilation = CreateCSharpCompilation(recordSource)
            using let peStream = File.Create(referencePath)
            let emitResult = compilation.Emit(
                peStream,
                options: EmitOptions(metadataOnly: true, includePrivateMembers: false)
            )
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            return referencePath
        }

        private func CreateCSharpCompilation(recordSource string) CSharpCompilation {
            let syntaxTree = CSharpSyntaxTree.ParseText(recordSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            return CSharpCompilation.Create(
                "CSharpLib2291",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
        }
    }
}
