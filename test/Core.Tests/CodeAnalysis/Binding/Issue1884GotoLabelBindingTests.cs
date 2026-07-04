// <copyright file="Issue1884GotoLabelBindingTests.cs" company="GSharp">
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
/// Issue #1884 / ADR-0139: binding and evaluation tests for general
/// `goto`/`label:` statements (a label on any non-loop statement is a `goto`
/// target) and their diagnostics (GS0469, GS0470).
/// </summary>
public class Issue1884GotoLabelBindingTests
{
    [Fact]
    public void BackwardGoto_LoopsBody_ProducesExpectedValue()
    {
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

    [Fact]
    public void ForwardGoto_SkipsInterveningStatement()
    {
        var source = """
            package P
            var hit = false
            goto after
            hit = true
            after:
            var done = true
            """;
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(false, vars["hit"]);
        Assert.Equal(true, vars["done"]);
    }

    [Fact]
    public void Goto_EscapesNestedIfBlock_ToOuterLabel()
    {
        var source = """
            package P
            var x = 2
            var branch = 0
            if x == 2 {
                branch = 1
                goto after
            }
            branch = 2
            after:
            var finished = true
            """;
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(1, vars["branch"]);
        Assert.Equal(true, vars["finished"]);
    }

    [Fact]
    public void LabelOnNonLoop_Binds_NoDiagnostics()
    {
        var source = """
            package P
            bogus: var x = 1
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void Goto_UndefinedLabel_Emits_GS0469()
    {
        var source = """
            package P
            goto nowhere
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0469");
    }

    [Fact]
    public void DuplicateLabel_Emits_GS0470()
    {
        var source = """
            package P
            lbl:
            var a = 1
            lbl:
            var b = 2
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0470");
    }

    [Fact]
    public void Goto_CanForwardReference_LabelDeclaredLater()
    {
        // The label is declared after the `goto` that targets it — this
        // must resolve without an undefined-label diagnostic (forward
        // reference), matching C#'s `goto` scoping.
        var source = """
            package P
            var reached = false
            goto after
            after:
            reached = true
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
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
