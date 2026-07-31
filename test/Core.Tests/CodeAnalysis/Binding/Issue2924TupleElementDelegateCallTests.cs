// <copyright file="Issue2924TupleElementDelegateCallTests.cs" company="GSharp">
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
/// Issue #2924: zero-based numeric tuple selectors remain attached to their
/// receiver and participate in ordinary indirect-call binding.
/// </summary>
public class Issue2924TupleElementDelegateCallTests
{
    [Fact]
    public void NumericSelectorCall_ParsesAsIndirectCall()
    {
        var tree = SyntaxTree.Parse("""
            package P
            let handler (int32) -> int32 = (value int32) -> value + 1
            let t = (handler, 0)
            t.0(1)
            """);

        Assert.Empty(tree.Diagnostics);
        var call = Walk(tree.Root)
            .OfType<CallExpressionSyntax>()
            .Single(expression => expression.Callee != null);
        var accessor = Assert.IsType<AccessorExpressionSyntax>(call.Callee);
        Assert.Equal("t", Assert.IsType<NameExpressionSyntax>(accessor.LeftPart).IdentifierToken.Text);
        Assert.Equal("0", Assert.IsType<NameExpressionSyntax>(accessor.RightPart).IdentifierToken.Text);
    }

    [Fact]
    public void NumericSelectors_ReadHigherAndNestedElements()
    {
        var result = Evaluate("""
            let t = ((10, 20), 30)
            t.0.1
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void NullConditionalNumericSelector_ReadsElement()
    {
        var result = Evaluate("""
            let t (int32, int32)? = (41, 0)
            t?.0
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(41, result.Value);
    }

    [Fact]
    public void SeparatedDotNumericSelector_ReadsElement()
    {
        var result = Evaluate("""
            let t = (41, 0)
            t. 0
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(41, result.Value);
    }

    [Fact]
    public void NestedMemberTupleSelectorCall_ParsesAsReceiverWideIndirectCall()
    {
        var tree = SyntaxTree.Parse("""
            package P
            import System
            data struct Holder(Value (System.Action[int32], int32))
            let handler System.Action[int32] = (value int32) -> Console.WriteLine(value)
            let holder = Holder((handler, 0))
            holder.Value.0(1)
            """);

        Assert.Empty(tree.Diagnostics);
        var call = Walk(tree.Root)
            .OfType<CallExpressionSyntax>()
            .Single(expression => expression.Callee != null);
        Assert.Equal("holder.Value.0", tree.Text.ToString(call.Callee.Span));
    }

    [Fact]
    public void CurriedMemberCall_ParsesAsReceiverWideIndirectCall()
    {
        var tree = SyntaxTree.Parse("""
            package P
            class Factory {
                func Make() (int32) -> int32 {
                    return (value int32) -> value + 1
                }
            }
            let factory = Factory()
            factory.Make()(41)
            """);

        Assert.Empty(tree.Diagnostics);
        var call = Walk(tree.Root)
            .OfType<CallExpressionSyntax>()
            .Single(expression => expression.Callee != null);
        Assert.Equal("factory.Make()", tree.Text.ToString(call.Callee.Span));
    }

    [Fact]
    public void PointerMemberCurriedCall_ParsesAsReceiverWideIndirectCall()
    {
        var tree = SyntaxTree.Parse("""
            package P
            q[0]->m(x)(y)
            """);

        Assert.Empty(tree.Diagnostics);
        var call = Walk(tree.Root)
            .OfType<CallExpressionSyntax>()
            .Single(expression => expression.Callee != null);
        Assert.Equal("q[0]->m(x)", tree.Text.ToString(call.Callee.Span));
    }

    [Fact]
    public void NullConditionalAssertedCurriedCall_ParsesAsReceiverWideIndirectCall()
    {
        var tree = SyntaxTree.Parse("""
            package P
            a?.b!!(x)(y)
            """);

        Assert.Empty(tree.Diagnostics);
        var calls = Walk(tree.Root)
            .OfType<CallExpressionSyntax>()
            .Where(expression => expression.Callee != null)
            .OrderBy(expression => expression.Span.Length)
            .ToArray();
        Assert.Equal(2, calls.Length);
        Assert.Equal("a?.b!!", tree.Text.ToString(calls[0].Callee.Span));
        Assert.Equal("a?.b!!(x)", tree.Text.ToString(calls[1].Callee.Span));
    }

    [Fact]
    public void NullConditionalCurriedMemberCall_ShortCircuitsNilReceiver()
    {
        var result = Evaluate("""
            class Factory {
                func Make(seed int32) (int32) -> int32 {
                    return (value int32) -> seed + value
                }
            }
            let factory Factory = nil
            factory?.Make(40)(2)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.Value);
    }

    [Fact]
    public void NullConditionalCurriedMemberCall_InvokesNonNilReceiver()
    {
        var result = Evaluate("""
            class Factory {
                func Make(seed int32) (int32) -> int32 {
                    return (value int32) -> seed + value
                }
            }
            let factory = Factory()
            factory?.Make(40)(2)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NullConditionalNumericSelectorCall_ShortCircuitsNilTuple()
    {
        var result = Evaluate("""
            let t (System.Func[int32, int32], int32)? = nil
            t?.0(1)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.Value);
    }

    [Fact]
    public void NullConditionalAssertedCall_InvokesAndShortCircuits()
    {
        var result = Evaluate("""
            class Factory {
                func Make(seed int32) (int32) -> int32 {
                    return (value int32) -> seed + value
                }
            }
            let live = Factory()
            let answer = live?.Make(40)!!(2)
            let repeated = live?.Make(40)!!!!(2)
            let missing Factory = nil
            missing?.Make(40)!!(2)
            missing?.Make(40)!!!!(2)
            answer + repeated
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void NumericSelectorAssignments_WriteTupleElement()
    {
        var result = Evaluate("""
            var assigned = (1, 2)
            assigned.0 = 5
            var compounded = (1, 2)
            compounded.0 += 6
            assigned.0 + compounded.0
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void NonCallableTupleElement_ReportsNotAFunction()
    {
        var result = Evaluate("""
            let t = (41, 0)
            t.0(1)
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.IsError && diagnostic.Id == "GS0131");
    }

    [Fact]
    public void ItemNameSelector_RemainsSupported()
    {
        var result = Evaluate("""
            let t = (41, 0)
            t.Item1
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(41, result.Value);
    }

    [Fact]
    public void ParenthesizedIndirectCall_RemainsSupported()
    {
        var result = Evaluate("""
            let increment (int32) -> int32 = (value int32) -> value + 1
            (increment)(41)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void LeadingDotFloat_RemainsLiteralInPrimaryPosition()
    {
        var result = Evaluate(".5 + .25");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0.75, result.Value);
    }

    [Fact]
    public void ExponentFloatAfterExpression_RemainsSeparateLiteral()
    {
        var result = Evaluate("""
            let t = (41, 0)
            t
            .5e1
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5.0, result.Value);
    }

    [Fact]
    public void AllDigitLeadingDotAcrossNewline_IsTupleSelector()
    {
        var result = Evaluate("""
            let t = (0, 1, 2, 3, 4, 5)
            t
            .5
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void IntegerAfterExpression_RemainsSeparateLiteral()
    {
        var result = Evaluate("""
            let t = (41, 0)
            t
            10
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static IEnumerable<SyntaxNode> Walk(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren().OfType<SyntaxNode>())
        {
            foreach (var descendant in Walk(child))
            {
                yield return descendant;
            }
        }
    }
}
