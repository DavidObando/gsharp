// <copyright file="Issue1263ConstructionGenericArityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1263: a construction <c>T[X](args)</c> must resolve the constructed
/// type by the supplied type-argument arity so a non-generic <c>T</c> and a
/// same-named generic <c>T[X]</c> can coexist. Previously the constructor-call
/// name resolution ignored the explicit type-argument list, bound to the
/// arity-0 <c>T</c>, and reported GS0148 ("requires 0 type arguments but was
/// given 1"). This is the construction-site analog of #1051.
/// </summary>
public class Issue1263ConstructionGenericArityTests
{
    [Fact]
    public void ConstructGenericWithSiblingNonGeneric_ResolvesGenericArity_NoDiagnostics()
    {
        const string source = """
            package p
            class Op { func M() {} }
            class Op[T] { let v T  init(v T) { this.v = v } }
            class C { func F() { let x = Op[int32](5) } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ConstructTwoArityGenericWithSiblingNonGeneric_ResolvesArity2_NoDiagnostics()
    {
        const string source = """
            package p
            class Pair { func M() {} }
            class Pair[A, B] { let a A  let b B  init(a A, b B) { this.a = a  this.b = b } }
            class C { func F() { let x = Pair[int32, string](5, "hi") } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ConstructWithNoMatchingArity_ReportsGS0148()
    {
        const string source = """
            package p
            class Op { func M() {} }
            class Op[T] { let v T  init(v T) { this.v = v } }
            class C { func F() { let x = Op[int32, int32](5) } }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0148");
    }

    [Fact]
    public void ConstructWithoutTypeArgs_PicksNonGeneric_NoDiagnostics()
    {
        const string source = """
            package p
            class Op { init() {} func M() {} }
            class Op[T] { let v T  init(v T) { this.v = v } }
            class C { func F() { let x = Op() } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ConstructGenericWithoutCollision_StillResolves_NoDiagnostics()
    {
        const string source = """
            package p
            class Op[T] { let v T  init(v T) { this.v = v } }
            class C { func F() { let x = Op[int32](5) } }
            """;
        Assert.Empty(Bind(source));
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToList();
    }
}
