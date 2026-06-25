// <copyright file="Issue1123AssignmentSmartCastBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1123 — Kotlin-style smart cast that narrows a nullable <c>var</c>
/// local to its non-nullable underlying type after the local is assigned a
/// statically non-nullable value. Mirrors the existing <c>if x is T</c> /
/// nil-guard smart-cast flow analysis, extended to assignment. Covers:
/// positive narrowing (straight-line and into nested blocks), re-narrowing,
/// the invalidation rules (reassigning to a possibly-null value clears the
/// narrowing), and a negative control (no narrowing without the assignment).
/// </summary>
public class Issue1123AssignmentSmartCastBinderTests
{
    [Fact]
    public void Assignment_OfNonNullValue_NarrowsNullableLocal()
    {
        // The minimal repro from the issue.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        return x.M()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Assignment_Narrowing_ReachesNestedBlock()
    {
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        if true {
            return x.M()
        }
        return 0
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Assignment_Narrowing_ReachesStraightLineStatements()
    {
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        var a = x.M()
        var b = x.M()
        return a + b
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Assignment_Narrowing_ToDerivedAssignedValue()
    {
        var result = Evaluate(@"
open class Base { open func M() int32 { return 1 } }
class Derived : Base { override func M() int32 { return 2 } }
class C {
    func F(d Derived) int32 {
        var x Base? = nil
        x = d
        return x.M()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Assignment_ReassignToPossiblyNull_ClearsNarrowing()
    {
        // Re-assigning `x` to a possibly-null value drops the narrowing, so the
        // subsequent member access fails again.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        x = maybe
        return x.M()
    }
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("M", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Assignment_ReNarrows_AfterPossiblyNullThenNonNull()
    {
        // A possibly-null assignment clears the narrowing; a following non-null
        // assignment re-establishes it.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = maybe
        x = fresh
        return x.M()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NoAssignment_NegativeControl_DoesNotNarrow()
    {
        // Without the narrowing assignment, the member access on `E?` fails.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F() int32 {
        var x E? = nil
        return x.M()
    }
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("M", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Assignment_NarrowingDoesNotEscapeBlock_AfterReassign()
    {
        // After re-assigning `x` to a possibly-null value the narrowing is gone
        // for the rest of the block, including nested blocks.
        var result = Evaluate(@"
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        x = maybe
        if true {
            return x.M()
        }
        return 0
    }
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("M", System.StringComparison.Ordinal));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
