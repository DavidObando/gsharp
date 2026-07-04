// <copyright file="Issue707WhileDoLabeledBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #707 / ADR-0070: binding-level tests for `while`, `do`-`while`,
/// labeled `break` / `continue`, and the associated diagnostics
/// (GS0120, GS0293, GS0295). Issue #1884 generalized `label:` onto non-loop
/// statements into `goto` targets (GS0469, GS0470) — see
/// Issue1884GotoLabelBindingTests.
/// </summary>
public class Issue707WhileDoLabeledBindingTests
{
    [Fact]
    public void While_Binds_Cleanly()
    {
        var source = """
            package P
            var i = 0
            while i < 3 { i = i + 1 }
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void DoWhile_Binds_Cleanly()
    {
        var source = """
            package P
            var i = 0
            do { i = i + 1 } while i < 3
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void LabeledFor_BreakLabel_BindsCleanly()
    {
        var source = """
            package P
            outer: for var i = 0; i < 3; i++ {
                for var j = 0; j < 3; j++ {
                    break outer
                    continue outer
                }
            }
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void LabeledWhile_BreakLabel_BindsCleanly()
    {
        var source = """
            package P
            outer: while true {
                for var j = 0; j < 1; j++ {
                    break outer
                }
            }
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void LabeledDoWhile_BreakLabel_BindsCleanly()
    {
        var source = """
            package P
            var n = 0
            spin: do {
                for var j = 0; j < 1; j++ {
                    break spin
                }
                n = n + 1
            } while n < 1
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void Break_OutsideLoop_Emits_GS0120()
    {
        var source = """
            package P
            break
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0120");
    }

    [Fact]
    public void Continue_OutsideLoop_Emits_GS0120()
    {
        var source = """
            package P
            continue
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0120");
    }

    [Fact]
    public void BreakWithUnknownLabel_Emits_GS0293()
    {
        var source = """
            package P
            for var i = 0; i < 1; i++ {
                break notalabel
            }
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0293");
    }

    [Fact]
    public void ContinueWithUnknownLabel_Emits_GS0293()
    {
        var source = """
            package P
            for var i = 0; i < 1; i++ {
                continue notalabel
            }
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0293");
    }

    [Fact]
    public void LabelOnNonLoop_IsValidGotoTarget()
    {
        // Issue #1884: a label on a non-loop statement no longer errors —
        // it declares a `goto` target instead of a loop label.
        var source = """
            package P
            bogus: if true { var x = 1 }
            """;
        var diags = Bind(source);
        Assert.Empty(diags);
    }

    [Fact]
    public void NestedLabelShadow_Emits_GS0295_Warning()
    {
        var source = """
            package P
            outer: for var i = 0; i < 1; i++ {
                outer: for var j = 0; j < 1; j++ {
                    break outer
                }
            }
            """;
        var diags = Bind(source);
        Assert.Contains(diags, d => d.Id == "GS0295");
    }

    [Fact]
    public void LabeledBreakFromInner_TargetsOuterBreakLabel()
    {
        // Sanity check: when nested loops both have break labels, the inner
        // `break outer` resolves to the *outer* loop's break target (the
        // first one allocated). The bound program printed by
        // BoundNodePrinter exposes the goto target name, so we can grep
        // for the expected target string.
        var source = """
            package P
            outer: for {
                for {
                    break outer
                }
            }
            """;
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        var program = Binder.BindProgram(compilation.GlobalScope, compilation.References);
        Assert.Empty(program.Diagnostics);

        var sb = new System.IO.StringWriter();
        program.Statement.WriteTo(sb);
        var text = sb.ToString();

        // Outer loop's BindLoopBody runs first → break1 / continue1.
        // Inner loop's BindLoopBody runs second → break2 / continue2.
        // The `break outer` must jump to `break1`, not `break2`.
        Assert.Contains("break1", text);
        Assert.Contains("goto break1", text);
    }

    private static System.Collections.Generic.IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return globalScope.Diagnostics.ToList();
    }
}
