// <copyright file="Issue2263CrossAssemblyDataClassWithTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2263: a cross-assembly `with`/copy on an IMPORTED `data class`
/// must compile, emit verifiable IL, and clone with the same reference
/// semantics as an in-assembly `data class` — matching the behaviour that
/// already worked for an imported `data struct`. The importer must recover
/// the class's data semantics from the `GSharp.TypeSemantics` marker the
/// emitter now also writes for data classes, and resolve the class to a single
/// semantic-aggregate `StructSymbol` consistently in every position
/// (let-initializer, argument, return, member access) so the resolution never
/// flickers.
open class Issue2263CrossAssemblyDataClassWithTests {
    @Fact
    func Imported_DataClass_With_Compiles_In_Let_Argument_And_Return_Positions() {
        let libraryPath = EmitLibrary("Imported_DataClass_With_Compiles_In_Let_Argument_And_Return_Positions")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From((`package Consumer
import Geometry

// return + argument positions: receiver is a parameter typed as
// the imported data class, result typed as the imported data class.
func Shift(p Point) Point -> p with { X = 99 }

func Run() int32 {
    // let-initializer position: construct then ` + "`" + `with` + "`" + `.
    let a = Point(1, 2)
    let b = a with { Y = 7 }
    let c = Shift(a)
    return a.X + a.Y + b.X + b.Y + c.X + c.Y
}`))))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_DataClass_SecondaryConstructor_IsCallable() {
        let libraryPath = EmitLibrary("Imported_DataClass_SecondaryConstructor_IsCallable")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.SecondaryConsumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Geometry

func Run() string -> Label("key").Header`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.SecondaryConsumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_DataClass_With_Clones_With_Reference_Semantics_At_Runtime() {
        let libraryPath = EmitLibrary("Imported_DataClass_With_Clones_With_Reference_Semantics_At_Runtime")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.Runner"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From((`package Runner
import Geometry

func Shift(p Point) Point -> p with { X = 99 }

func Main() {
    let a = Point(1, 2)
    let b = Shift(a)

    // nested data-class field copied via ` + "`" + `with` + "`" + `.
    let ln = Line(Point(0, 0), Point(5, 5))
    let ln2 = ln with { End = Point(9, 9) }

    // Original left untouched (reference semantics), clone updated.
    Console.WriteLine(a.X)
    Console.WriteLine(a.Y)
    Console.WriteLine(b.X)
    Console.WriteLine(b.Y)
    Console.WriteLine(ln.End.X)
    Console.WriteLine(ln2.End.X)
    Console.WriteLine(ln2.Start.X)
}`))))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Runner")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        let output = LoadInvokeCaptureStdout(peStream, libraryPath, "Issue2263-Runner")
        let lines = output.ReplaceLineEndings(Environment.NewLine).Split(
            Environment.NewLine,
            StringSplitOptions.RemoveEmptyEntries
        )
        Assert.Equal([]string{"1", "2", "99", "2", "5", "9", "0"}, lines)
    }

    @Fact
    func Imported_DataClass_With_Resolves_Deterministically_Across_Repeated_Compilations() {
        let libraryPath = EmitLibrary("Imported_DataClass_With_Resolves_Deterministically_Across_Repeated_Compilations")
        const ConsumerSource = `package Consumer
import Geometry

func Shift(p Point) Point -> p with { X = 99 }

func Run() int32 {
    let a = Point(1, 2)
    let b = Shift(a)
    return b.X + b.Y
}`
        // The prior prototype flickered: the same source resolved the imported
        // data class to its semantic aggregate in some runs and to a bare
        // ImportedTypeSymbol in others, so GS0161 appeared non-deterministically.
        // A fresh resolver per iteration avoids any cross-run cache carry-over.
        for var i = 0; i < 12; i++ {
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            resolver.CurrentAssemblyName = "Geometry.Consumer"
            let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(ConsumerSource)))
            using let peStream = MemoryStream()
            let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Consumer")
            Assert.True(
                result.Success,
                "iteration $i must not flicker: " + string.Join(Environment.NewLine, result.Diagnostics)
            )
        }
    }

    shared {
        private const LibrarySource string = `package Geometry

data class Point(X int32, Y int32)

data class Line(Start Point, End Point)

data class Label(Key string, Header string) {
    convenience init(key string) {
        init(key, key)
    }
}`

        private func EmitLibrary(caseName string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2263", caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Geometry.Library.dll")
            let library = Compilation(SyntaxTree.Parse(SourceText.From(LibrarySource))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }

        private func LoadInvokeCaptureStdout(peStream MemoryStream, libraryPath string, contextName string) string {
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            loadContext.Resolving += (context AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                name.Name,
                "Geometry.Library",
                StringComparison.Ordinal
            ) {
                context.LoadFromAssemblyPath(libraryPath)
            } else {
                default(Assembly?)
            }
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let entry MethodInfo? = asm.EntryPoint
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
