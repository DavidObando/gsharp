// <copyright file="ImportedClrStaticImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0134 (extended): a non-alias type import whose dotted target names a
/// <em>referenced-assembly CLR type</em> (rather than a same-compilation source
/// class) brings that type's <c>public static</c> members into scope for
/// unqualified reference — the imported-CLR analogue of the source-class
/// <c>using static</c> hoisting. cs2gs translates C#'s
/// <c>using static System.Math</c> to <c>import System.Math</c>, so unqualified
/// <c>Sqrt(x)</c> / <c>PI</c> must resolve exactly as <c>Math.Sqrt(x)</c> /
/// <c>Math.PI</c>. These tests pin call, static-field, static-property, and
/// overload behaviour, and that a plain namespace import does NOT hoist.
/// </summary>
public class ImportedClrStaticImportTests
{
    [Fact]
    public void TypeImportOfClrType_ExposesStaticMethod_ForUnqualifiedCall()
    {
        var source = """
            package p
            import System.Math
            func compute() float64 -> Sqrt(4.0)
            """;

        AssertNoUnresolvedReference(Emit(source));
    }

    [Fact]
    public void TypeImportOfClrType_ExposesStaticMethodOverload_ForUnqualifiedCall()
    {
        var source = """
            package p
            import System.Math
            func biggest(a int32, b int32) int32 -> Max(a, b)
            """;

        AssertNoUnresolvedReference(Emit(source));
    }

    [Fact]
    public void TypeImportOfClrType_ExposesStaticField_ForUnqualifiedRead()
    {
        var source = """
            package p
            import System.Math
            func pi() float64 -> PI
            """;

        AssertNoUnresolvedReference(Emit(source));
    }

    [Fact]
    public void NamespaceImport_DoesNotHoistClrStatics()
    {
        // `import System` names a NAMESPACE, not a type, so `Sqrt` must remain
        // unresolved (GS0130), mirroring C# where only `using static System.Math`
        // — not `using System` — hoists Math's members.
        var source = """
            package p
            import System
            func compute() float64 -> Sqrt(4.0)
            """;

        Assert.Contains(Emit(source), d => d.Id == "GS0130");
    }

    private static void AssertNoUnresolvedReference(ImmutableArray<Diagnostic> diagnostics)
    {
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0130");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
    }

    private static ImmutableArray<Diagnostic> Emit(string source)
    {
        var runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var paths = Directory.GetFiles(runtimeDir, "*.dll");
        var references = ReferenceResolver.WithReferences(paths);
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(references, tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics;
    }
}
