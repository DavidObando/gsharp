// <copyright file="Issue1929CrossAssemblySemanticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1929: G# metadata imports must preserve data-struct semantics,
/// positional construction, receiver-clause extension methods, and friend-like
/// internal visibility across assembly boundaries.
/// </summary>
public class Issue1929CrossAssemblySemanticsTests
{
    [Fact]
    public void Imported_DataStruct_Semantics_RoundTrip_Through_Metadata()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue1929.Library.dll");
        EmitLibraryAssembly(libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Issue1929.Library.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Demo

                func Run() int32 {
                    let start = Point(1, 2)
                    let moved = start with { x = 3 }
                    let target = Point{ x: 10, y: 20 }
                    return moved.DistanceTo(target) + moved.secretSauce()
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue1929.Library.Tests");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static void EmitLibraryAssembly(string libraryPath)
    {
        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo

                data struct Point(x int32, y int32)

                func (p Point) DistanceTo(other Point) int32 {
                    return (other.x - p.x) + (other.y - p.y)
                }

                internal func (p Point) secretSauce() int32 {
                    return (p.x * 100) + p.y
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue1929.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
