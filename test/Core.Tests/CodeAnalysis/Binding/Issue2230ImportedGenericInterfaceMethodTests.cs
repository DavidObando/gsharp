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

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
