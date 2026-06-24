// <copyright file="Issue1070FieldInitializerStaticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1070: a static member of a type (a <c>const</c>, or a <c>shared</c>
/// field) must be visible from a field-initializer expression in the same type,
/// just like it already is from a method/constructor body. These binder tests
/// assert that such references no longer produce GS0125 ("Variable doesn't
/// exist") nor the cascading GS0159, that the resolution is order-independent,
/// and that genuine instance-member references are still rejected (GS0377).
/// </summary>
public class Issue1070FieldInitializerStaticTests
{
    [Fact]
    public void InstanceInitializer_ReferencingClassConst_NoGS0125OrGS0159()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    private let buf []uint8 = System.GC.AllocateArray[uint8](BlockSize)\n" +
            "    const BlockSize int32 = 16\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void InstanceInitializer_ReferencingClassConst_OrderIndependent()
    {
        // The const is declared BEFORE the field initializer here; still resolves.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    const BlockSize int32 = 16\n" +
            "    private let buf []uint8 = System.GC.AllocateArray[uint8](BlockSize)\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void SharedFieldInitializer_ReferencingSiblingSharedField_NoGS0125()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    shared {\n" +
            "        let Rates []int32 = []int32{1, 2, 3}\n" +
            "        let First int32 = Rates[0]\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void InstanceInitializer_ReferencingSharedField_NoGS0125()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    shared { let S int32 = 7 }\n" +
            "    let x int32 = S\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void SharedFieldInitializer_ReferencingClassConst_NoGS0125()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    const Factor int32 = 10\n" +
            "    shared { let Scaled int32 = Factor * 2 }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void InstanceInitializer_ReferencingInstanceMember_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let a int32 = 5\n" +
            "    let b int32 = a\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_ReferencingUndefinedName_StillReportsGS0125()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let b int32 = doesNotExist\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0125");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics.ToList();
    }
}
