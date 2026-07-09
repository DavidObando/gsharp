// <copyright file="Issue2263CrossAssemblyDataClassWithTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2263: a cross-assembly <c>with</c>/copy on an IMPORTED <c>data class</c>
/// must compile, emit verifiable IL, and clone with the same reference
/// semantics as an in-assembly <c>data class</c> — matching the behaviour that
/// already worked for an imported <c>data struct</c>. The importer must recover
/// the class's data semantics from the <c>GSharp.TypeSemantics</c> marker the
/// emitter now also writes for data classes, and resolve the class to a single
/// semantic-aggregate <c>StructSymbol</c> consistently in every position
/// (let-initializer, argument, return, member access) so the resolution never
/// flickers.
/// </summary>
public class Issue2263CrossAssemblyDataClassWithTests
{
    private const string LibrarySource = """
        package Geometry

        data class Point(X int32, Y int32)

        data class Line(Start Point, End Point)
        """;

    [Fact]
    public void Imported_DataClass_With_Compiles_In_Let_Argument_And_Return_Positions()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_DataClass_With_Compiles_In_Let_Argument_And_Return_Positions));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Geometry.Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Geometry

                // return + argument positions: receiver is a parameter typed as
                // the imported data class, result typed as the imported data class.
                func Shift(p Point) Point -> p with { X = 99 }

                func Run() int32 {
                    // let-initializer position: construct then `with`.
                    let a = Point(1, 2)
                    let b = a with { Y = 7 }
                    let c = Shift(a)
                    return a.X + a.Y + b.X + b.Y + c.X + c.Y
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_DataClass_With_Clones_With_Reference_Semantics_At_Runtime()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_DataClass_With_Clones_With_Reference_Semantics_At_Runtime));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Geometry.Runner";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Runner
                import Geometry

                func Shift(p Point) Point -> p with { X = 99 }

                func Main() {
                    let a = Point(1, 2)
                    let b = Shift(a)

                    // nested data-class field copied via `with`.
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
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Geometry.Runner");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        var output = LoadInvokeCaptureStdout(peStream, libraryPath, "Issue2263-Runner");
        var lines = output
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);

        Assert.Equal(new[] { "1", "2", "99", "2", "5", "9", "0" }, lines);
    }

    [Fact]
    public void Imported_DataClass_With_Resolves_Deterministically_Across_Repeated_Compilations()
    {
        var libraryPath = EmitLibrary(nameof(this.Imported_DataClass_With_Resolves_Deterministically_Across_Repeated_Compilations));

        const string ConsumerSource = """
            package Consumer
            import Geometry

            func Shift(p Point) Point -> p with { X = 99 }

            func Run() int32 {
                let a = Point(1, 2)
                let b = Shift(a)
                return b.X + b.Y
            }
            """;

        // The prior prototype flickered: the same source resolved the imported
        // data class to its semantic aggregate in some runs and to a bare
        // ImportedTypeSymbol in others, so GS0161 appeared non-deterministically.
        // A fresh resolver per iteration avoids any cross-run cache carry-over.
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
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2263", caseName);
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
