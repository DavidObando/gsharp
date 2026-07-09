// <copyright file="Issue2278ImportedGenericDataClassTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2278 (follow-up to #2263): an imported GENERIC <c>data class</c>
/// must support construction, member access, and <c>with</c>/copy exactly
/// like the non-generic case #2263 fixed — for ANY arity (1, 2, ...), for a
/// nested generic type argument (<c>Box[List[int32]]</c> / <c>Box[Box[int32]]</c>),
/// and for a data class whose fields reference the class's own type
/// parameters. #2263 explicitly excluded generics because the OPEN
/// definition would otherwise build a 0-arity aggregate shadowing every
/// closed instantiation; this fix builds the semantic aggregate from the
/// CLOSED CLR generic type instead (a distinct <see cref="Type"/> per
/// instantiation, sharing the marker's metadata token with the open
/// definition), so each closed generic keeps its own correctly-shaped,
/// consistent identity.
/// </summary>
public class Issue2278ImportedGenericDataClassTests
{
    private const string LibrarySource = """
        package Geometry

        data class Box[T](Value T)

        data class Pair[K, V](Key K, Value V)
        """;

    [Fact]
    public void Imported_Arity1_GenericDataClass_With_Compiles_In_Let_Argument_And_Return_Positions()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_Arity1_GenericDataClass_With_Compiles_In_Let_Argument_And_Return_Positions));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Geometry.Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Geometry

                // return + argument positions: receiver is a parameter typed as
                // the imported closed generic data class, result typed the same way.
                func Shift(b Box[int32]) Box[int32] -> b with { Value = 99 }

                func Run() int32 {
                    // let-initializer position: construct then `with`.
                    let a = Box[int32](1)
                    let b = a with { Value = 7 }
                    let c = Shift(a)
                    return a.Value + b.Value + c.Value
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_Arity2_GenericDataClass_With_And_MemberAccess_Compile()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_Arity2_GenericDataClass_With_And_MemberAccess_Compile));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Geometry.Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Geometry

                func Run() int32 {
                    let p = Pair[int32, string](1, "hi")
                    let p2 = p with { Value = "bye" }
                    return p.Key + p2.Key
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_NestedGenericArgument_GenericDataClass_With_And_MemberAccess_Compile()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_NestedGenericArgument_GenericDataClass_With_And_MemberAccess_Compile));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Geometry.Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Geometry

                func Run() int32 {
                    // Box[Box[int32]] — a nested generic type argument (the outer
                    // Box closes over another closed instantiation of itself).
                    let inner = Box[int32](5)
                    let outer = Box[Box[int32]](inner)
                    let outer2 = outer with { Value = Box[int32](9) }
                    return outer.Value.Value + outer2.Value.Value
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_NullableOfGenericDataClass_Compiles()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_NullableOfGenericDataClass_Compiles));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Geometry.Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Geometry

                func Run() bool {
                    var m Box[int32]? = nil
                    let wasNil = m == nil
                    m = Box[int32](3)
                    return wasNil && m.Value == 3
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_GenericDataClass_With_Clones_With_Reference_Semantics_At_Runtime()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_GenericDataClass_With_Clones_With_Reference_Semantics_At_Runtime));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Geometry.Runner";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Runner
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
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Runner");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        var output = LoadInvokeCaptureStdout(peStream, libraryPath, "Issue2278-Runner");
        var lines = output
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);

        Assert.Equal(new[] { "1", "99", "1", "hi", "1", "bye" }, lines);
    }

    [Fact]
    public void Imported_GenericDataClass_Resolves_Deterministically_Across_Repeated_Compilations()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_GenericDataClass_Resolves_Deterministically_Across_Repeated_Compilations));

        const string ConsumerSource = """
            package Consumer
            import Geometry

            func Shift(b Box[int32]) Box[int32] -> b with { Value = 99 }

            func Run() int32 {
                let a = Box[int32](1)
                let b = Shift(a)
                return b.Value
            }
            """;

        // Mirrors the #2263 flicker regression test: a fresh resolver per
        // iteration avoids any cross-run cache carry-over, and every
        // iteration must resolve the imported generic data class to its
        // semantic aggregate consistently (never a bare ImportedTypeSymbol).
        for (var i = 0; i < 12; i++)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
            resolver.CurrentAssemblyName = "Geometry.Consumer";

            var consumer = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(ConsumerSource)));
            using var peStream = new MemoryStream();
            var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Consumer");
            Assert.True(
                result.Success,
                $"iteration {i} must not flicker: " + string.Join(Environment.NewLine, result.Diagnostics));
        }
    }

    private static string EmitLibrary(string caseName)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2278", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Geometry.Library.dll");

        var library = new Compilation(SyntaxTree.Parse(SourceText.From(LibrarySource)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }

    private static string LoadInvokeCaptureStdout(MemoryStream peStream, string libraryPath, string contextName)
    {
        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        loadContext.Resolving += (context, name) =>
            string.Equals(name.Name, "Geometry.Library", StringComparison.Ordinal)
                ? context.LoadFromAssemblyPath(libraryPath)
                : null;

        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var entry = asm.EntryPoint;
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
