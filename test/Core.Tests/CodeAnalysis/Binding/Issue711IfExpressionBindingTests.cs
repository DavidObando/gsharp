// <copyright file="Issue711IfExpressionBindingTests.cs" company="GSharp">
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
/// Issue #711 / ADR-0064 — binder-level diagnostics and typing rules for
/// `if` used as a value-producing expression. Mirrors the diagnostic
/// surface called out in the issue scope:
/// <list type="bullet">
///   <item><description>GS0276 — missing <c>else</c> in expression position.</description></item>
///   <item><description>GS0277 — block tail in expression position is not a value-producing expression.</description></item>
///   <item><description>GS0263 — branches have no common type (shared with ADR-0062 ternary).</description></item>
/// </list>
/// </summary>
public class Issue711IfExpressionBindingTests
{
    [Fact]
    public void IfExpression_InLetInit_WithElse_BindsCleanly()
    {
        var result = Evaluate(@"
let x = if true { 1 } else { 2 }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfExpression_MissingElse_Diagnoses_GS0276()
    {
        var result = Evaluate(@"
let x = if true { 1 }
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0276");
    }

    [Fact]
    public void IfExpression_ChainMissingFinalElse_Diagnoses_GS0276()
    {
        // The else-if chain is right-associative; the innermost if has no
        // terminal `else`, so GS0276 reports against that inner if.
        var result = Evaluate(@"
let x = if true { 1 } else if false { 2 }
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0276");
    }

    [Fact]
    public void IfExpression_EmptyThenBlock_Diagnoses_GS0277()
    {
        var result = Evaluate(@"
let x = if true { } else { 1 }
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0277");
    }

    [Fact]
    public void IfExpression_EmptyElseBlock_Diagnoses_GS0277()
    {
        var result = Evaluate(@"
let x = if true { 1 } else { }
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0277");
    }

    [Fact]
    public void IfExpression_TailIsNonExpressionStatement_Diagnoses_GS0277()
    {
        // The block's last statement is a `for`-loop, not an expression
        // statement, so the trailing-expression slot is null and GS0277
        // fires. This pins down the "branch tail is a non-expression
        // statement" rule from issue #711's binder scope.
        var result = Evaluate(@"
let x = if true {
    for i in 0...3 {
    }
} else {
    42
}
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0277");
    }

    [Fact]
    public void IfExpression_BranchesHaveNoCommonType_Diagnoses_GS0263()
    {
        var result = Evaluate(@"
let x = if true { ""yes"" } else { 1 }
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0263");
    }

    [Fact]
    public void IfExpression_NumericWideningChoosesCommonType()
    {
        // ADR-0062 / ADR-0037 numeric widening: int32 + int64 → int64.
        var result = Evaluate(@"
let a int32 = 1
let b int64 = 2
let x = if true { a } else { b }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfExpression_NilAndReferenceBranches_BindNullableResult()
    {
        // `nil` on one arm and a nullable reference on the other unifies
        // via the null sentinel rule in ComputeConditionalCommonType: the
        // result is `string?`.
        var result = Evaluate(@"
let s string? = ""hi""
let x = if true { s } else { nil }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfStatement_WithoutElse_StillCompiles()
    {
        // Regression guard: an `if` used as a statement may omit `else`
        // and must NOT trigger GS0276. The statement-form path is
        // unaffected by ADR-0064.
        var result = Evaluate(@"
func Run() {
    if true {
        var unused = 1
    }
}
Run()
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0277");
    }

    [Fact]
    public void IfExpression_MultiStatementBlock_BindsTrailingExpression()
    {
        var result = Evaluate(@"
import System
var sink = """"
let x = if true {
    sink = ""a""
    42
} else {
    0
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfExpression_AsCallArgument_Binds()
    {
        var result = Evaluate(@"
import System
Console.WriteLine(if true { ""on"" } else { ""off"" })
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfExpression_InReturn_Binds()
    {
        var result = Evaluate(@"
func Pick(b bool) int32 {
    return if b { 1 } else { -1 }
}
Pick(true)
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfExpression_WithThrowInPrefixOfBranch_BindsFollowingSwitchExpressionRule()
    {
        // `throw` is a statement in G# (the switch expression also does not
        // accept `throw` as an arm value). Placing a `throw` statement
        // before the tail expression should still bind: the block's tail is
        // a valid expression, and the throw simply makes the tail
        // unreachable at runtime. The binder does not flag unreachability
        // for tails in expression position, matching the switch-expression
        // rule.
        var result = Evaluate(@"
import System
func Run(b bool) int32 {
    let x = if b {
        throw Exception(message: ""bad"")
        0
    } else {
        1
    }
    return x
}
");

        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
