// <copyright file="Issue1194FieldAndCtorInitializerScopeTests.cs" company="GSharp">
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
/// Issue #1194: a field initializer and a constructor-initializer
/// (<c>: base(...)</c> / <c>: this(...)</c>) must be able to resolve unqualified
/// calls to top-level free functions and to the enclosing type's static members
/// (methods, consts, static fields), matching C#. These binder tests assert the
/// references no longer produce GS0130 ("Function doesn't exist") nor GS0125
/// ("Variable doesn't exist"), are order independent, and that genuine instance
/// member references from a field initializer are still rejected (GS0377).
/// </summary>
public class Issue1194FieldAndCtorInitializerScopeTests
{
    [Fact]
    public void FieldInitializer_CallingFreeFunction_NoGS0130()
    {
        const string source =
            "package p\n" +
            "func GetName() string { return \"x\" }\n" +
            "class C {\n" +
            "    let Title string = GetName()\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0130");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void FieldInitializer_CallingSiblingStaticMethod_OrderIndependent_NoGS0130()
    {
        // The static method is declared AFTER the field initializer.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    shared {\n" +
            "        let Title string = GetName()\n" +
            "        private func GetName() string { return \"x\" }\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0130");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void BaseConstructorInitializer_ReferencingSiblingConst_NoGS0125()
    {
        const string source =
            "package p\n" +
            "open class Base { init(x uint64) { } }\n" +
            "class Derived : Base {\n" +
            "    init() : base(Poly) { }\n" +
            "    shared { const Poly uint64 = 5UL }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0130");
    }

    [Fact]
    public void FieldInitializer_ReferencingInstanceMember_StillReportsGS0377()
    {
        // Instance members are genuinely unavailable in a field initializer
        // ('this' does not exist yet) — GS0377 must still fire.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let A int32 = B\n" +
            "    let B int32 = 3\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics.ToList();
    }
}
