// <copyright file="Issue1929CrossAssemblySemanticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis.Binding;
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

                @assembly:InternalsVisibleTo("Issue1929.Library.Tests")

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

    /// <summary>
    /// Blocking review finding on #1953: naming a consumer assembly
    /// <c>&lt;Owner&gt;.Tests</c> must NOT unilaterally grant internal access.
    /// A library that never declares
    /// <c>@assembly:InternalsVisibleTo("...")</c> must reject an internal
    /// member access from a same-named-by-convention consumer.
    /// </summary>
    [Fact]
    public void Consumer_Named_Dot_Tests_Without_Producer_OptIn_Cannot_See_Internal_Members()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929NoOptIn");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "NoOptIn.Library.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo

                data struct Point(x int32, y int32)

                internal func (p Point) secretSauce() int32 {
                    return (p.x * 100) + p.y
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "NoOptIn.Library");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        // Naming convention only — the producer above never declared
        // InternalsVisibleTo for this name.
        resolver.CurrentAssemblyName = "NoOptIn.Library.Tests";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Demo

                func Run() int32 {
                    let p = Point(1, 2)
                    return p.secretSauce()
                }
                """)));

        using var peStream2 = new MemoryStream();
        var result = consumer.Emit(peStream2, pdbStream: null, refStream: null, assemblyName: "NoOptIn.Library.Tests");
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    /// <summary>
    /// A consumer explicitly granted friendship via
    /// <c>@assembly:InternalsVisibleTo("...")</c> can see internal members
    /// even when its assembly name shares no naming convention with the
    /// producer at all (proving this is genuine producer opt-in, not a name
    /// heuristic).
    /// </summary>
    [Fact]
    public void Consumer_Explicitly_Granted_InternalsVisibleTo_Can_See_Internal_Members_Regardless_Of_Name()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929ExplicitOptIn");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "ExplicitOptIn.Library.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo

                @assembly:InternalsVisibleTo("Totally.Unrelated.Consumer.Name")

                data struct Point(x int32, y int32)

                internal func (p Point) secretSauce() int32 {
                    return (p.x * 100) + p.y
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "ExplicitOptIn.Library");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Totally.Unrelated.Consumer.Name";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Demo

                func Run() int32 {
                    let p = Point(1, 2)
                    return p.secretSauce()
                }
                """)));

        using var peStream2 = new MemoryStream();
        var result = consumer.Emit(peStream2, pdbStream: null, refStream: null, assemblyName: "Totally.Unrelated.Consumer.Name");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    /// <summary>
    /// Non-blocking review finding #2: <c>Compilation.AssemblyName</c> must be
    /// honored regardless of whether the caller touches
    /// <see cref="Compilation.GlobalScope"/> (e.g. reading diagnostics) before
    /// or after setting it, as long as it is set before the first
    /// <see cref="Compilation.GlobalScope"/> access — previously the assembly
    /// name was only pushed onto <see cref="ReferenceResolver.CurrentAssemblyName"/>
    /// inside <c>Emit</c>, so any earlier <c>GlobalScope</c> access froze
    /// internal-visibility binding with an empty consumer name.
    /// </summary>
    [Fact]
    public void Setting_AssemblyName_Before_GlobalScope_Access_Makes_Internal_Visibility_Order_Independent()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929CallOrder");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "CallOrder.Library.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo

                @assembly:InternalsVisibleTo("CallOrder.Library.Tests")

                data struct Point(x int32, y int32)

                internal func (p Point) secretSauce() int32 {
                    return (p.x * 100) + p.y
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(libraryPath))
        {
            var libResult = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "CallOrder.Library");
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Demo

                func Run() int32 {
                    let p = Point(1, 2)
                    return p.secretSauce()
                }
                """)))
        {
            // Set before touching GlobalScope, simulating a host (IDE/CLI)
            // that knows its target assembly name up front.
            AssemblyName = "CallOrder.Library.Tests",
        };

        // Force GlobalScope (and thus binding) before Emit ever runs — this
        // is exactly the order that used to freeze visibility with an empty
        // consumer name because CurrentAssemblyName was only ever set inside
        // Emit().
        _ = consumer.GlobalScope.Diagnostics;

        using var peStream2 = new MemoryStream();
        var result = consumer.Emit(peStream2, pdbStream: null, refStream: null, assemblyName: "CallOrder.Library.Tests");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    /// <summary>
    /// Non-blocking review finding #3: the positional-ctor metadata payload
    /// must not silently drop a parameter whose name diverges from its
    /// backing field's name — <see cref="ImportedTypeSymbol"/> now resolves
    /// each parameter's type via the backing field's metadata token first,
    /// falling back to name matching only when no token was recorded.
    /// </summary>
    [Fact]
    public void BuildPrimaryConstructorParameters_Resolves_By_FieldToken_Even_When_Name_Diverges()
    {
        var fieldType = TypeSymbol.Int32;
        var backingField = new FieldSymbol("x", fieldType, Accessibility.Public, isReadOnly: true);
        const int fakeFieldToken = 0x04000042;
        var fieldByToken = new System.Collections.Generic.Dictionary<int, FieldSymbol> { [fakeFieldToken] = backingField };

        // The parameter name intentionally does NOT match any field/property
        // name — simulating a future rename/mangling divergence — but the
        // token points at the real backing field.
        var semantics = new ImportedTypeSemantics(
            MetadataToken: 0x02000005,
            IsValueType: true,
            IsData: true,
            PrimaryConstructorParameterNames: ImmutableArray.Create("renamedParam"),
            PrimaryConstructorParameterFieldTokens: ImmutableArray.Create(fakeFieldToken));

        var method = typeof(ImportedTypeSymbol).GetMethod(
            "BuildPrimaryConstructorParameters",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(method);

        var result = (ImmutableArray<ParameterSymbol>)method.Invoke(
            null,
            new object[]
            {
                ImmutableArray<FieldSymbol>.Empty,
                ImmutableArray<PropertySymbol>.Empty,
                fieldByToken,
                semantics,
            });

        var parameter = Assert.Single(result);
        Assert.Equal("renamedParam", parameter.Name);
        Assert.Same(fieldType, parameter.Type);
    }
}
