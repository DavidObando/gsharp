// <copyright file="Issue2027GotoLabelIsolationBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2027 (follow-up to #1884 / PR #2025): the <c>goto</c>/label
/// namespace (<see cref="BinderContext.UserLabels"/> /
/// <see cref="BinderContext.DefinedUserLabels"/> /
/// <see cref="BinderContext.UnresolvedGotoLabels"/>) and the loop-label
/// stack (<see cref="BinderContext.LoopStack"/>) must be isolated per
/// function-equivalent frame — a lambda or a local function is its own
/// frame, distinct from its enclosing function, matching C#'s prohibition
/// on cross-frame <c>goto</c> flow. These tests pin: a nested-frame
/// <c>goto</c> referencing an outer-only label is undefined (GS0469) rather
/// than silently resolving cross-frame; a nested frame may declare its own
/// label reusing an outer name with no leak in either direction; and a
/// single-frame (no lambda/local-function nesting) <c>goto</c> still works
/// exactly as before.
/// </summary>
public class Issue2027GotoLabelIsolationBinderTests
{
    [Fact]
    public void Lambda_GotoReferencesOuterOnlyLabel_EmitsGS0469()
    {
        // "outerLabel" is declared only in the enclosing function; the
        // lambda's own goto/label frame never sees it.
        var source = """
            package P
            var reached = false
            outerLabel:
            reached = true
            let f = (x int32) -> { goto outerLabel
            return x }
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0469");
    }

    [Fact]
    public void Lambda_DeclaresOwnLabelMatchingOuterName_NoLeak()
    {
        // Both the enclosing function and the lambda declare a "sameLabel"
        // — separate frames, so this must bind cleanly with no duplicate-
        // label (GS0470) or undefined-label (GS0469) diagnostic, and the
        // lambda's `goto` must resolve to the lambda's OWN label.
        var source = """
            package P
            var outerHit = false
            sameLabel:
            outerHit = true
            let f = (x int32) -> {
                goto sameLabel
                sameLabel:
                return x
            }
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void LocalFunction_GotoReferencesOuterOnlyLabel_EmitsGS0469()
    {
        var source = """
            package P
            outerLabel:
            var reached = false
            let f = func() {
                goto outerLabel
            }
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0469");
    }

    [Fact]
    public void LocalFunction_DeclaresOwnLabelMatchingOuterName_NoLeak()
    {
        var source = """
            package P
            var outerHit = false
            sameLabel:
            outerHit = true
            let f = func() {
                goto sameLabel
                sameLabel:
                var innerHit = true
            }
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void LabelInsideLambda_NotVisibleToEnclosingGoto_EmitsGS0469()
    {
        // The reverse leak direction: a label declared ONLY inside the
        // lambda must not satisfy a `goto` in the enclosing function.
        var source = """
            package P
            var reached = false
            goto innerOnly
            let f = (x int32) -> {
                innerOnly:
                return x
            }
            reached = true
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0469");
    }

    [Fact]
    public void SingleFrame_NoNesting_GotoStillWorks_NoRegression()
    {
        // Sanity: plain top-level goto/label with no lambda/local-function
        // nesting binds and evaluates exactly as before this fix.
        var source = """
            package P
            var a = 0
            retry:
            a = a + 1
            if a < 3 {
                goto retry
            }
            """;
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(3, vars["a"]);
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return globalScope.Diagnostics.ToList();
    }

    private static (EvaluationResult Result, Dictionary<string, object> Variables) EvaluateWithVariables(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var variables = new Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(variables);

        var namedVars = new Dictionary<string, object>();
        foreach (var kvp in variables)
        {
            namedVars[kvp.Key.Name] = kvp.Value;
        }

        return (result, namedVars);
    }
}
