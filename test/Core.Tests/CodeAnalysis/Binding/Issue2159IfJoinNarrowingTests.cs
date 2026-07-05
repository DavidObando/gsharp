// <copyright file="Issue2159IfJoinNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2159 — narrow a nullable <c>var</c> local to its non-nullable
/// underlying type at the JOIN point after an <c>if</c> when the local is
/// non-null on <em>every</em> branch exit (via assignment inside the branch
/// and/or condition-implied narrowing). Generalises the straight-line
/// assignment narrowing (issue #1123) and the early-exit narrowing
/// (issue #700) to the "null-check then reassign in the null branch" idiom.
/// Covers the positive repros, the generic form, the negative controls that
/// must still block narrowing, an <c>else if</c> chain, and post-if
/// re-nullable-ization.
/// </summary>
public class Issue2159IfJoinNarrowingTests
{
    [Fact]
    public void ReassignInNullBranch_NoElse_Narrows()
    {
        // Repro (1): non-null branch reached via the implicit negated-condition
        // else (`r != nil`); the then-branch reassigns `r` to a non-null value.
        var result = Evaluate(@"
package T
func mk() string -> ""x""
func f1(s string?) string {
    var r string? = s
    if r == nil { r = mk() }
    return r
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void AssignNonNullInBothBranches_Narrows()
    {
        // Repro (2): then assigns a fresh non-null value; else assigns the
        // condition-narrowed (non-null) parameter.
        var result = Evaluate(@"
package T
func mk() string -> ""x""
func f2(s string?) string {
    var r string?
    if s == nil { r = mk() } else { r = s }
    return r
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericClassConstrained_Narrows()
    {
        // Repro (3): generic form; `T` carries a `class` constraint so `T?` → `T`
        // is a metadata-only narrowing.
        var result = Evaluate(@"
package T
func f3[T class init()](s object?) T {
    var r T? = s as T
    if r == nil { r = T() }
    return r
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ElseIfChain_EveryTerminalBranchNonNull_Narrows()
    {
        var result = Evaluate(@"
package T
func mk() string -> ""x""
func f(a bool, s string?) string {
    var r string? = s
    if a { r = mk() } else if r == nil { r = mk() } else { r = mk() }
    return r
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void EarlyExitInNullBranch_StillNarrows()
    {
        // Regression guard: the already-working early-exit idiom stays clean.
        var result = Evaluate(@"
package T
func mk() string -> ""x""
func f(s string?) string {
    var r string? = s
    if r == nil { return mk() }
    return r
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UnrelatedBool_NoElse_DoesNotNarrow()
    {
        // Negative: the implicit else leaves `r` at its declared nullable type
        // because the condition does not narrow it.
        var result = Evaluate(@"
package T
func mk() string -> ""x""
func f(c bool) string {
    var r string?
    if c { r = mk() }
    return r
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert", StringComparison.Ordinal));
    }

    [Fact]
    public void EmptyThen_DoesNotNarrow()
    {
        // Negative: the then-branch leaves `r` nil.
        var result = Evaluate(@"
package T
func f(s string?) string {
    var r string? = s
    if r == nil { }
    return r
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert", StringComparison.Ordinal));
    }

    [Fact]
    public void AssignNullableInBranch_DoesNotNarrow()
    {
        // Negative: the branch assigns a possibly-null value, so `r` is not
        // proven non-null on that exit.
        var result = Evaluate(@"
package T
func maybe() string? -> nil
func f(s string?) string {
    var r string? = s
    if r == nil { r = maybe() }
    return r
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert", StringComparison.Ordinal));
    }

    [Fact]
    public void ReassignToNilAfterNonNull_DoesNotNarrow()
    {
        // Negative: a later reassignment to nil inside the branch clears the
        // non-null fact established by the earlier assignment.
        var result = Evaluate(@"
package T
func mk() string -> ""x""
func f(s string?) string {
    var r string? = s
    if r == nil {
        r = mk()
        r = nil
    }
    return r
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert", StringComparison.Ordinal));
    }

    [Fact]
    public void PostIfReassignToNull_ReNullableIzes()
    {
        // The join narrows `r`, but a subsequent reassignment to nil invalidates
        // it, so the later use fails again.
        var result = Evaluate(@"
package T
func mk() string -> ""x""
func f(s string?) string {
    var r string? = s
    if r == nil { r = mk() }
    r = nil
    return r
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert", StringComparison.Ordinal));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
