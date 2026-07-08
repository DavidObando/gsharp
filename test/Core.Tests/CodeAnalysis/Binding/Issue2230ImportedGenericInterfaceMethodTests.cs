// <copyright file="Issue2230ImportedGenericInterfaceMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2230: gsc supported matching generic interface-method
/// implementations for SOURCE-declared interfaces (issue #1007,
/// <c>TryBuildMethodTypeParameterMap</c>) but rejected the identical shape
/// when the interface came from an IMPORTED (metadata) assembly — the
/// separate CLR-interface verification path
/// (<c>DeclarationBinder.VerifyClrInterfaceImplementations</c> /
/// <c>MemberLookup.HasMatchingMethodForClrSignature</c>) never unified the
/// interface method's own generic parameters against the implementer's,
/// spuriously reporting GS0187 (e.g. <c>ILogger.BeginScope&lt;TState&gt;</c> /
/// <c>ILogger.Log&lt;TState&gt;</c>).
/// </summary>
public class Issue2230ImportedGenericInterfaceMethodTests
{
    /// <summary>
    /// Baseline (kept passing before and after the fix): a generic method
    /// implementing a SOURCE-declared interface in the same compilation
    /// already worked via issue #1007's <c>TryBuildMethodTypeParameterMap</c>.
    /// </summary>
    [Fact]
    public void SourceInterface_GenericMethodImplementation_BindsCleanly()
    {
        const string source = """
            package t
            interface IStore { func Put[T](item T) bool; func Name() string; }
            class MyStore : IStore { func Put[T](item T) bool { return true } func Name() string { return "my" } }
            """;
        Assert.Empty(Bind(source));
    }

    /// <summary>
    /// Exact minimal repro from issue #2230: <c>IStore.Put[T]</c> comes from a
    /// SEPARATELY compiled (imported/metadata) assembly. Before the fix, this
    /// spuriously reported GS0187 even though the implicit implementation is
    /// correct.
    /// </summary>
    [Fact]
    public void ImportedInterface_GenericMethodImplementation_BindsCleanly()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Issue2230.Lib.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Lib
                interface IStore { func Put[T](item T) bool; func Name() string; }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2230.Lib");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue2230.Lib.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package App
                import Lib
                class MyStore : IStore { func Put[T](item T) bool { return true } func Name() string { return "my" } }
                """)));

        Assert.Empty(consumer.GlobalScope.Diagnostics.Where(d => d.IsError));
    }

    /// <summary>
    /// ILogger-shaped multi-param generic method: the interface method carries
    /// an interface-irrelevant method type parameter (<c>TState</c>) plus an
    /// ordinary parameter that nests it inside a constructed generic delegate
    /// (<c>Func&lt;TState, Exception, string&gt;</c>), pinning the
    /// nested-generic-arg substitution described in the issue. Uses a real BCL
    /// <c>Func&lt;,,&gt;</c> delegate over a <see cref="MetadataLoadContext"/>-backed
    /// reference set (mirrors cs2gs / the MSBuild task compile mode), the same
    /// harness pattern as issue #1958.
    /// </summary>
    [Fact]
    public void ImportedInterface_GenericMethodWithNestedFuncParameter_BindsCleanly()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Logger");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Issue2230.LoggerLib.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package LoggerLib
                interface ILoggerLike {
                    func Log[TState](state TState, formatter (TState, string) -> string) string;
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2230.LoggerLib");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue2230.LoggerLib.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package App
                import LoggerLib
                class MyLogger : ILoggerLike {
                    func Log[TState](state TState, formatter (TState, string) -> string) string { return formatter(state, "x") }
                }
                """)));

        Assert.Empty(consumer.GlobalScope.Diagnostics.Where(d => d.IsError));
    }

    /// <summary>
    /// A generic-arity mismatch against an IMPORTED interface method must
    /// still be rejected with GS0187 — the fix must not accept every
    /// same-name candidate regardless of arity.
    /// </summary>
    [Fact]
    public void ImportedInterface_NonGenericMethod_DoesNotSatisfyGenericInterfaceMethod_ReportsGS0187()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Arity");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Issue2230.ArityLib.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package ArityLib
                interface IStore { func Put[T](item T) bool; }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2230.ArityLib");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue2230.ArityLib.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package App
                import ArityLib
                class MyStore : IStore { func Put(item int32) bool { return true } }
                """)));

        Assert.Contains(consumer.GlobalScope.Diagnostics, d => d.Id == "GS0187");
    }

    /// <summary>
    /// Follow-up to the Opus rubber-duck review of #2249: an imported
    /// generic method parameter nested inside a CLR ARRAY of the method's
    /// own type parameter (e.g. <c>TState[]</c> in
    /// <c>IReadOnlyCollection&lt;T&gt;.CopyTo(T[], int)</c>) must also match —
    /// arrays aren't <c>IsConstructedGenericType</c> in the reflection sense,
    /// so they need their own element-wise recursion, distinct from the
    /// constructed-delegate/generic-type branches.
    /// </summary>
    [Fact]
    public void ImportedInterface_GenericMethodWithArrayOfTypeParameterParameter_BindsCleanly()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Array");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Issue2230.ArrayLib.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package ArrayLib
                interface ICopier { func CopyTo[T](items []T, index int32) void; }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2230.ArrayLib");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue2230.ArrayLib.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package App
                import ArrayLib
                class MyCopier : ICopier { func CopyTo[T](items []T, index int32) void {  } }
                """)));

        Assert.Empty(consumer.GlobalScope.Diagnostics.Where(d => d.IsError));
    }

    /// <summary>
    /// Follow-up to the Opus rubber-duck review of #2249: an imported
    /// generic method's RETURN type nested inside a non-delegate constructed
    /// generic (<c>IEnumerable&lt;TState&gt;</c>) of the method's own type
    /// parameter must also match, generalizing beyond the delegate-only
    /// slow path.
    /// </summary>
    [Fact]
    public void ImportedInterface_GenericMethodWithEnumerableOfTypeParameterReturn_BindsCleanly()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230Enumerable");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Issue2230.EnumerableLib.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package EnumerableLib
                import System.Collections.Generic
                interface IWrapper { func Wrap[T](item T) IEnumerable[T]; }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2230.EnumerableLib");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue2230.EnumerableLib.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package App
                import EnumerableLib
                import System.Collections.Generic
                class MyWrapper : IWrapper { func Wrap[T](item T) IEnumerable[T] { return []T{item} } }
                """)));

        Assert.Empty(consumer.GlobalScope.Diagnostics.Where(d => d.IsError));
    }

    /// <summary>
    /// Follow-up to the Opus rubber-duck review of #2249: proves the
    /// generalized recursion isn't arity/depth-limited to a single nesting
    /// level — a doubly-nested constructed generic
    /// (<c>IEnumerable&lt;IEnumerable&lt;TState&gt;&gt;</c>) must also match.
    /// </summary>
    [Fact]
    public void ImportedInterface_GenericMethodWithDoublyNestedEnumerableReturn_BindsCleanly()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230NestedEnumerable");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Issue2230.NestedEnumerableLib.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package NestedEnumerableLib
                import System.Collections.Generic
                interface IWrapper { func WrapNested[T](item T) IEnumerable[IEnumerable[T]]; }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2230.NestedEnumerableLib");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue2230.NestedEnumerableLib.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package App
                import NestedEnumerableLib
                import System.Collections.Generic
                class MyWrapper : IWrapper { func WrapNested[T](item T) IEnumerable[IEnumerable[T]] { return []IEnumerable[T]{[]T{item}} } }
                """)));

        Assert.Empty(consumer.GlobalScope.Diagnostics.Where(d => d.IsError));
    }

    /// <summary>
    /// Review point #2 (LOW priority, cheap to pin): a candidate method with
    /// matching PARAMETER shape but a WRONG return type — the interface
    /// requires <c>func Put[T](item T) T</c> but the candidate implements
    /// <c>func Put[T](item T) bool</c> — must still correctly fail with
    /// GS0187. Proves the generalized recursion doesn't accidentally bypass
    /// return-type checking.
    /// </summary>
    [Fact]
    public void ImportedInterface_GenericMethodWithWrongReturnType_ReportsGS0187()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2230WrongReturn");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Issue2230.WrongReturnLib.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package WrongReturnLib
                interface IStore { func Put[T](item T) T; }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2230.WrongReturnLib");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue2230.WrongReturnLib.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package App
                import WrongReturnLib
                class MyStore : IStore { func Put[T](item T) bool { return true } }
                """)));

        Assert.Contains(consumer.GlobalScope.Diagnostics, d => d.Id == "GS0187");
    }

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
