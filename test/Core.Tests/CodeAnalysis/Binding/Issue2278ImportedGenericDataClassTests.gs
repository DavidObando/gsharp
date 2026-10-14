// <copyright file="Issue2278ImportedGenericDataClassTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2278 (follow-up to #2263): an imported GENERIC `data class`
/// must support construction, member access, and `with`/copy exactly
/// like the non-generic case #2263 fixed — for ANY arity (1, 2, ...), for a
/// nested generic type argument (`Box[List[int32]]` / `Box[Box[int32]]`),
/// and for a data class whose fields reference the class's own type
/// parameters. #2263 explicitly excluded generics because the OPEN
/// definition would otherwise build a 0-arity aggregate shadowing every
/// closed instantiation; this fix builds the semantic aggregate from the
/// CLOSED CLR generic type instead (a distinct (cref:Type) per
/// instantiation, sharing the marker's metadata token with the open
/// definition), so each closed generic keeps its own correctly-shaped,
/// consistent identity.
open class Issue2278ImportedGenericDataClassTests {
    @Fact
    func Imported_Arity1_GenericDataClass_With_Compiles_In_Let_Argument_And_Return_Positions() {
        let libraryPath = EmitLibrary(
            "Imported_Arity1_GenericDataClass_With_Compiles_In_Let_Argument_And_Return_Positions"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From((`package Consumer
import Geometry

// return + argument positions: receiver is a parameter typed as
// the imported closed generic data class, result typed the same way.
func Shift(b Box[int32]) Box[int32] -> b with { Value = 99 }

func Run() int32 {
    // let-initializer position: construct then ` + "`" + `with` + "`" + `.
    let a = Box[int32](1)
    let b = a with { Value = 7 }
    let c = Shift(a)
    return a.Value + b.Value + c.Value
}`))))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_Arity2_GenericDataClass_With_And_MemberAccess_Compile() {
        let libraryPath = EmitLibrary("Imported_Arity2_GenericDataClass_With_And_MemberAccess_Compile")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Geometry

func Run() int32 {
    let p = Pair[int32, string](1, "hi")
    let p2 = p with { Value = "bye" }
    return p.Key + p2.Key
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_NestedGenericArgument_GenericDataClass_With_And_MemberAccess_Compile() {
        let libraryPath = EmitLibrary("Imported_NestedGenericArgument_GenericDataClass_With_And_MemberAccess_Compile")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Geometry

func Run() int32 {
    // Box[Box[int32]] — a nested generic type argument (the outer
    // Box closes over another closed instantiation of itself).
    let inner = Box[int32](5)
    let outer = Box[Box[int32]](inner)
    let outer2 = outer with { Value = Box[int32](9) }
    return outer.Value.Value + outer2.Value.Value
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_NullableOfGenericDataClass_Compiles() {
        let libraryPath = EmitLibrary("Imported_NullableOfGenericDataClass_Compiles")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Geometry

func Run() bool {
    var m Box[int32]? = nil
    let wasNil = m == nil
    m = Box[int32](3)
    return wasNil && m.Value == 3
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Imported_GenericDataClass_With_Clones_With_Reference_Semantics_At_Runtime() {
        let libraryPath = EmitLibrary("Imported_GenericDataClass_With_Clones_With_Reference_Semantics_At_Runtime")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Geometry.Runner"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Runner
import Geometry

func Shift(b Box[int32]) Box[int32] -> b with { Value = 99 }

func Main() {
    let a = Box[int32](1)
    let b = Shift(a)

    let p = Pair[int32, string](1, "hi")
    let p2 = p with { Value = "bye" }

    // Original left untouched (reference semantics), clone updated.
    Console.WriteLine(a.Value)
    Console.WriteLine(b.Value)
    Console.WriteLine(p.Key)
    Console.WriteLine(p.Value)
    Console.WriteLine(p2.Key)
    Console.WriteLine(p2.Value)
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Geometry.Runner")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        let output = LoadInvokeCaptureStdout(peStream, libraryPath, "Issue2278-Runner")
        let lines = output.ReplaceLineEndings(Environment.NewLine).Split(
            Environment.NewLine,
            StringSplitOptions.RemoveEmptyEntries
        )
        Assert.Equal([]string{"1", "99", "1", "hi", "1", "bye"}, lines)
    }

    @Fact
    func Imported_GenericDataClass_Resolves_Deterministically_Across_Repeated_Compilations() {
        let libraryPath = EmitLibrary(
            "Imported_GenericDataClass_Resolves_Deterministically_Across_Repeated_Compilations"
        )
        const ConsumerSource = `package Consumer
import Geometry

func Shift(b Box[int32]) Box[int32] -> b with { Value = 99 }

func Run() int32 {
    let a = Box[int32](1)
    let b = Shift(a)
    return b.Value
}`
        // Mirrors the #2263 flicker regression test: a fresh resolver per
        // iteration avoids any cross-run cache carry-over, and every
        // iteration must resolve the imported generic data class to its
        // semantic aggregate consistently (never a bare ImportedTypeSymbol).
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

data class Box[T](Value T)

data class Pair[K, V](Key K, Value V)`

        private func EmitLibrary(caseName string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2278", caseName)
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
