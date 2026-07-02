// <copyright file="Issue708IfLetGuardLetBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #708 / ADR-0071 — binder coverage for <c>if let</c> and
/// <c>guard let</c> nullable-binding statements: diagnostic surface,
/// scoping rules, and composition with the ADR-0069 flow-narrowing
/// machinery.
/// </summary>
public class Issue708IfLetGuardLetBindingTests
{
    [Fact]
    public void IfLet_NonNullableRhs_Diagnoses_GS0296()
    {
        var result = Evaluate(@"
func Run() {
    var s = ""hi""
    if let v = s {
        var x = v
    }
}
Run()
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0296");
    }

    [Fact]
    public void IfLet_NullableRhs_NarrowsBindingInThenBranch()
    {
        // Inside the then-branch, `v` is narrowed to `string` and may be
        // passed to a `string`-typed parameter.
        var result = Evaluate(@"
func Take(s string) int32 { return s.Length }
func Run(s string?) int32 {
    if let v = s {
        return Take(v)
    }
    return 0
}
Run(""hi"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfLet_BindingNotVisibleInElseBranch()
    {
        var result = Evaluate(@"
func Run(s string?) int32 {
    if let v = s {
        return v.Length
    } else {
        return v.Length
    }
}
Run(""hi"")
");

        // `v` is not visible in the else branch.
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0001" || d.Message.Contains("v"));
    }

    [Fact]
    public void IfLet_MultipleBindings_AllNarrowInThenBranch()
    {
        var result = Evaluate(@"
func Take(a string, b string) int32 { return a.Length + b.Length }
func Run(a string?, b string?) int32 {
    if let x = a, let y = b {
        return Take(x, y)
    }
    return 0
}
Run(""a"", ""b"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GuardLet_ElseWithoutExit_Diagnoses_GS0297()
    {
        var result = Evaluate(@"
func Run(s string?) {
    guard let v = s else {
        var x = 1
    }
    var y = v
}
Run(""hi"")
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0297");
    }

    [Fact]
    public void GuardLet_ElseWithReturn_IsAccepted()
    {
        var result = Evaluate(@"
func Run(s string?) int32 {
    guard let v = s else {
        return 0
    }
    return v.Length
}
Run(""hi"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GuardLet_ElseWithThrow_IsAccepted()
    {
        // Void-returning function: the throw is recognised as an
        // unconditional exit (GS0297 must not fire). The
        // ControlFlowGraph all-paths-return analysis is not consulted
        // for void returns, so this exercises the GS0297 exit-set
        // independently of the "must return a value" check.
        var result = Evaluate(@"
import System
func Run(s string?) {
    guard let v = s else {
        throw Exception(message: ""boom"")
    }
    var x = v
}
Run(""hi"")
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0297");
    }

    [Fact]
    public void GuardLet_NonNullableRhs_Diagnoses_GS0296()
    {
        var result = Evaluate(@"
func Run() int32 {
    var s = ""hi""
    guard let v = s else {
        return 0
    }
    return v.Length
}
Run()
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0296");
    }

    [Fact]
    public void GuardLet_NarrowsBindingForRestOfBlock()
    {
        // After a successful `guard let v = s`, `v` is in scope for the
        // remainder of the block and typed as the underlying non-null
        // type.
        var result = Evaluate(@"
func Take(s string) int32 { return s.Length }
func Run(s string?) int32 {
    guard let v = s else {
        return 0
    }
    return Take(v)
}
Run(""hi"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GuardLet_MultipleBindings_AllNarrow()
    {
        var result = Evaluate(@"
func Take(a string, b string) int32 { return a.Length + b.Length }
func Run(a string?, b string?) int32 {
    guard let x = a, let y = b else {
        return 0
    }
    return Take(x, y)
}
Run(""a"", ""b"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfLet_ComposesWithDownstreamSmartCast()
    {
        // Inside the then-branch, `v` has been narrowed from `string?`
        // to `string`. A subsequent `&& v.Length > 0` short-circuit
        // should accept the member access without a further guard.
        var result = Evaluate(@"
func Run(s string?) int32 {
    if let v = s {
        if v.Length > 0 {
            return v.Length
        }
    }
    return 0
}
Run(""hi"")
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GuardLet_SingleBinding_ElseDiagnosticReportedExactlyOnce()
    {
        // Issue #1637: the else block used to be bound once as a
        // validity probe and once more per binding arm, so a single
        // binding produced the same diagnostic twice.
        var result = Evaluate(@"
func Run(s string?) int32 {
    guard let v = s else {
        var w = ""hi""
        guard let n = w else {
            return 0
        }
        return n.Length
    }
    return v.Length
}
Run(""hi"")
");

        Assert.Single(result.Diagnostics, d => d.Id == "GS0296");
    }

    [Fact]
    public void GuardLet_MultipleBindings_ElseDiagnosticReportedExactlyOnce()
    {
        // Issue #1637: with N binding arms the else block used to be
        // re-bound N+1 times, reporting every diagnostic inside it
        // N+1 times instead of once.
        var result = Evaluate(@"
func Run(a string?, b string?) int32 {
    guard let x = a, let y = b else {
        var w = ""hi""
        guard let n = w else {
            return 0
        }
        return n.Length
    }
    return x.Length + y.Length
}
Run(""a"", ""b"")
");

        Assert.Single(result.Diagnostics, d => d.Id == "GS0296");
    }

    [Fact]
    public void GuardLet_MultipleBindings_ElseWithoutExit_DiagnosesGS0297ExactlyOnce()
    {
        var result = Evaluate(@"
func Run(a string?, b string?) {
    guard let x = a, let y = b else {
        var z = 1
    }
    var w = x
    var q = y
}
Run(""a"", ""b"")
");

        Assert.Single(result.Diagnostics, d => d.Id == "GS0297");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
