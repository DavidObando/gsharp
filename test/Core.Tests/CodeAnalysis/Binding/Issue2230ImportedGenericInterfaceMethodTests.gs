// <copyright file="Issue2230ImportedGenericInterfaceMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2230: gsc supported matching generic interface-method
/// implementations for SOURCE-declared interfaces (issue #1007,
/// `TryBuildMethodTypeParameterMap`) but rejected the identical shape
/// when the interface came from an IMPORTED (metadata) assembly — the
/// separate CLR-interface verification path
/// (`DeclarationBinder.VerifyClrInterfaceImplementations` /
/// `MemberLookup.FindMatchingMethodForClrSignature`) never unified the
/// interface method's own generic parameters against the implementer's,
/// spuriously reporting GS0187 (e.g. `ILogger.BeginScope<TState>` /
/// `ILogger.Log<TState>`).
open class Issue2230ImportedGenericInterfaceMethodTests {
    /// Baseline (kept passing before and after the fix): a generic method
    /// implementing a SOURCE-declared interface in the same compilation
    /// already worked via issue #1007's `TryBuildMethodTypeParameterMap`.
    @Fact
    func SourceInterface_GenericMethodImplementation_BindsCleanly() {
        const source = `package t
interface IStore { func Put[T](item T) bool; func Name() string; }
class MyStore : IStore { func Put[T](item T) bool { return true } func Name() string { return "my" } }`
        Assert.Empty(Bind(source))
    }

    /// Exact minimal repro from issue #2230: `IStore.Put[T]` comes from a
    /// SEPARATELY compiled (imported/metadata) assembly. Before the fix, this
    /// spuriously reported GS0187 even though the implicit implementation is
    /// correct.
    @Fact
    func ImportedInterface_GenericMethodImplementation_BindsCleanly() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2230.Lib.dll")
        let library = Compilation(
            SyntaxTree.Parse(
                SourceText.From("package Lib\ninterface IStore { func Put[T](item T) bool; func Name() string; }")
            )
        ){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2230.Lib")
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue2230.Lib.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package App
import Lib
class MyStore : IStore { func Put[T](item T) bool { return true } func Name() string { return "my" } }`)))
        Assert.Empty(consumer.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    /// ILogger-shaped multi-param generic method: the interface method carries
    /// an interface-irrelevant method type parameter (`TState`) plus an
    /// ordinary parameter that nests it inside a constructed generic delegate
    /// (`Func<TState, Exception, string>`), pinning the
    /// nested-generic-arg substitution described in the issue. Uses a real BCL
    /// `Func<,,>` delegate over a (cref:MetadataLoadContext)-backed
    /// reference set (mirrors cs2gs / the MSBuild task compile mode), the same
    /// harness pattern as issue #1958.
    @Fact
    func ImportedInterface_GenericMethodWithNestedFuncParameter_BindsCleanly() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Logger")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2230.LoggerLib.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package LoggerLib
interface ILoggerLike {
    func Log[TState](state TState, formatter (TState, string) -> string) string;
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2230.LoggerLib")
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue2230.LoggerLib.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package App
import LoggerLib
class MyLogger : ILoggerLike {
    func Log[TState](state TState, formatter (TState, string) -> string) string { return formatter(state, "x") }
}`)))
        Assert.Empty(consumer.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    /// A generic-arity mismatch against an IMPORTED interface method must
    /// still be rejected with GS0187 — the fix must not accept every
    /// same-name candidate regardless of arity.
    @Fact
    func ImportedInterface_NonGenericMethod_DoesNotSatisfyGenericInterfaceMethod_ReportsGS0187() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Arity")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2230.ArityLib.dll")
        let library = Compilation(
            SyntaxTree.Parse(SourceText.From("package ArityLib\ninterface IStore { func Put[T](item T) bool; }"))
        ){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2230.ArityLib")
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue2230.ArityLib.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package App
import ArityLib
class MyStore : IStore { func Put(item int32) bool { return true } }`)))
        Assert.Contains(consumer.GlobalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    /// Follow-up to the Opus rubber-duck review of #2249: an imported
    /// generic method parameter nested inside a CLR ARRAY of the method's
    /// own type parameter (e.g. `TState[]` in
    /// `IReadOnlyCollection<T>.CopyTo(T[], int)`) must also match —
    /// arrays aren't `IsConstructedGenericType` in the reflection sense,
    /// so they need their own element-wise recursion, distinct from the
    /// constructed-delegate/generic-type branches.
    @Fact
    func ImportedInterface_GenericMethodWithArrayOfTypeParameterParameter_BindsCleanly() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Array")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2230.ArrayLib.dll")
        let library = Compilation(
            SyntaxTree.Parse(
                SourceText.From("package ArrayLib\ninterface ICopier { func CopyTo[T](items []T, index int32) void; }")
            )
        ){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2230.ArrayLib")
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue2230.ArrayLib.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package App
import ArrayLib
class MyCopier : ICopier { func CopyTo[T](items []T, index int32) void {  } }`)))
        Assert.Empty(consumer.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    /// Follow-up to the Opus rubber-duck review of #2249: an imported
    /// generic method's RETURN type nested inside a non-delegate constructed
    /// generic (`IEnumerable<TState>`) of the method's own type
    /// parameter must also match, generalizing beyond the delegate-only
    /// slow path.
    @Fact
    func ImportedInterface_GenericMethodWithEnumerableOfTypeParameterReturn_BindsCleanly() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Enumerable")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2230.EnumerableLib.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package EnumerableLib
import System.Collections.Generic
interface IWrapper { func Wrap[T](item T) IEnumerable[T]; }`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue2230.EnumerableLib"
            )
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue2230.EnumerableLib.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package App
import EnumerableLib
import System.Collections.Generic
class MyWrapper : IWrapper { func Wrap[T](item T) IEnumerable[T] { return []T{item} } }`)))
        Assert.Empty(consumer.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    /// Follow-up to the Opus rubber-duck review of #2249: proves the
    /// generalized recursion isn't arity/depth-limited to a single nesting
    /// level — a doubly-nested constructed generic
    /// (`IEnumerable<IEnumerable<TState>>`) must also match.
    @Fact
    func ImportedInterface_GenericMethodWithDoublyNestedEnumerableReturn_BindsCleanly() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230NestedEnumerable")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2230.NestedEnumerableLib.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package NestedEnumerableLib
import System.Collections.Generic
interface IWrapper { func WrapNested[T](item T) IEnumerable[IEnumerable[T]]; }`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue2230.NestedEnumerableLib"
            )
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue2230.NestedEnumerableLib.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package App
import NestedEnumerableLib
import System.Collections.Generic
class MyWrapper : IWrapper { func WrapNested[T](item T) IEnumerable[IEnumerable[T]] { return []IEnumerable[T]{[]T{item}} } }`)))
        Assert.Empty(consumer.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    /// Review point #2 (LOW priority, cheap to pin): a candidate method with
    /// matching PARAMETER shape but a WRONG return type — the interface
    /// requires `func Put[T](item T) T` but the candidate implements
    /// `func Put[T](item T) bool` — must still correctly fail with
    /// GS0187. Proves the generalized recursion doesn't accidentally bypass
    /// return-type checking.
    @Fact
    func ImportedInterface_GenericMethodWithWrongReturnType_ReportsGS0187() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230WrongReturn")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2230.WrongReturnLib.dll")
        let library = Compilation(
            SyntaxTree.Parse(SourceText.From("package WrongReturnLib\ninterface IStore { func Put[T](item T) T; }"))
        ){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue2230.WrongReturnLib"
            )
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue2230.WrongReturnLib.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package App
import WrongReturnLib
class MyStore : IStore { func Put[T](item T) bool { return true } }`)))
        Assert.Contains(consumer.GlobalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
