// <copyright file="Issue2924TupleElementDelegateCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2924: zero-based numeric tuple selectors remain attached to their
/// receiver and participate in ordinary indirect-call binding.
open class Issue2924TupleElementDelegateCallTests {
    @Fact
    func NumericSelectorCall_ParsesAsIndirectCall() {
        let tree = SyntaxTree.Parse(`package P
let handler (int32) -> int32 = (value int32) -> value + 1
let t = (handler, 0)
t.0(1)`)
        Assert.Empty(tree.Diagnostics)
        let call = Walk(tree.Root).OfType[CallExpressionSyntax]().Single(
            (expression CallExpressionSyntax) -> expression.Callee != nil
        )
        let accessor = Assert.IsType[AccessorExpressionSyntax](call.Callee)
        Assert.Equal("t", Assert.IsType[NameExpressionSyntax](accessor.LeftPart).IdentifierToken.Text)
        Assert.Equal("0", Assert.IsType[NameExpressionSyntax](accessor.RightPart).IdentifierToken.Text)
    }

    @Fact
    func NumericSelectors_ReadHigherAndNestedElements() {
        let result = Evaluate("let t = ((10, 20), 30)\nt.0.1")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(20, result.Value)
    }

    @Fact
    func NullConditionalNumericSelector_ReadsElement() {
        let result = Evaluate("let t (int32, int32)? = (41, 0)\nt?.0")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(41, result.Value)
    }

    @Fact
    func SeparatedDotNumericSelector_ReadsElement() {
        let result = Evaluate("let t = (41, 0)\nt. 0")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(41, result.Value)
    }

    @Fact
    func NestedMemberTupleSelectorCall_ParsesAsReceiverWideIndirectCall() {
        let tree = SyntaxTree.Parse(`package P
import System
data struct Holder(Value (System.Action[int32], int32))
let handler System.Action[int32] = (value int32) -> Console.WriteLine(value)
let holder = Holder((handler, 0))
holder.Value.0(1)`)
        Assert.Empty(tree.Diagnostics)
        let call = Walk(tree.Root).OfType[CallExpressionSyntax]().Single(
            (expression CallExpressionSyntax) -> expression.Callee != nil
        )
        Assert.Equal("holder.Value.0", tree.Text.ToString(call.Callee!!.Span))
    }

    @Fact
    func CurriedMemberCallShapes_ParseAsReceiverWideIndirectCalls() {
        let shapes = [](string, string){
            ("factory.Make(40)(2)", "factory.Make(40)"),
            ("factory.Make[int32](40)(2)", "factory.Make[int32](40)"),
            ("factory.Make(40)[0](2)", "factory.Make(40)[0]"),
            ("factory.Make(40)(2)(3)", "factory.Make(40)(2)")
        }
        for (expression, expectedCallee) in shapes {
            let tree = SyntaxTree.Parse((`package P
` + "$expression"))
            Assert.Empty(tree.Diagnostics)
            Assert.Contains(
                Walk(tree.Root).OfType[CallExpressionSyntax](),
                (call CallExpressionSyntax) -> call.Callee != nil && tree.Text.ToString(
                    call.Callee!!.Span
                ) == expectedCallee
            )
        }
    }

    @Fact
    func PointerMemberCurriedCall_ParsesAsReceiverWideIndirectCall() {
        let tree = SyntaxTree.Parse("package P\nq[0]->m(x)(y)")
        Assert.Empty(tree.Diagnostics)
        let call = Walk(tree.Root).OfType[CallExpressionSyntax]().Single(
            (expression CallExpressionSyntax) -> expression.Callee != nil
        )
        Assert.Equal("q[0]->m(x)", tree.Text.ToString(call.Callee!!.Span))
    }

    @Fact
    func NullConditionalAssertedCurriedCall_ParsesAsReceiverWideIndirectCall() {
        let tree = SyntaxTree.Parse("package P\na?.b!!(x)(y)")
        Assert.Empty(tree.Diagnostics)
        let calls = Walk(tree.Root)
            .OfType[CallExpressionSyntax]()
            .Where((expression CallExpressionSyntax) -> expression.Callee != nil)
            .OrderBy((expression CallExpressionSyntax) -> expression.Span.Length)
            .ToArray()
        Assert.Equal(2, calls.Length)
        Assert.Equal("a?.b!!", tree.Text.ToString(calls[0].Callee!!.Span))
        Assert.Equal("a?.b!!(x)", tree.Text.ToString(calls[1].Callee!!.Span))
    }

    @Fact
    func NullConditionalCurriedMemberCall_ShortCircuitsNilReceiver() {
        let result = Evaluate(`class Factory {
    func Make(seed int32) (int32) -> int32 {
        return (value int32) -> seed + value
    }
}
let factory Factory? = nil
factory?.Make(40)(2)`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.Value)
    }

    @Fact
    func NullConditionalCurriedMemberCall_InvokesNonNilReceiver() {
        let result = Evaluate(`class Factory {
    func Make(seed int32) (int32) -> int32 {
        return (value int32) -> seed + value
    }
}
let factory = Factory()
factory?.Make(40)(2)`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullConditionalNumericSelectorCall_ShortCircuitsNilTuple() {
        let result = Evaluate("let t (System.Func[int32, int32], int32)? = nil\nt?.0(1)")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.Value)
    }

    @Fact
    func NullConditionalAssertedCall_InvokesAndShortCircuits() {
        let result = Evaluate(`class Factory {
    func Make(seed int32) (int32) -> int32 {
        return (value int32) -> seed + value
    }
}
let live = Factory()
let answer = live?.Make(40)!!(2)
let repeated = live?.Make(40)!!!!(2)
let missing Factory? = nil
missing?.Make(40)!!(2)
missing?.Make(40)!!!!(2)
answer + repeated`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(84, result.Value)
    }

    @Fact
    func NumericSelectorAssignments_WriteTupleElement() {
        let result = Evaluate(`var assigned = (1, 2)
assigned.0 = 5
var compounded = (1, 2)
compounded.0 += 6
assigned.0 + compounded.0`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(12, result.Value)
    }

    @Fact
    func MissingTupleSelector_ReportsCleanDiagnostic() {
        let result = Evaluate("var t = (1, 2)\nt. = 5")
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0158")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
    }

    @Fact
    func NonCallableTupleElement_ReportsNotAFunction() {
        let result = Evaluate("let t = (41, 0)\nt.0(1)")
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError && diagnostic.Id == "GS0131")
    }

    @Fact
    func ItemNameSelector_RemainsSupported() {
        let result = Evaluate("let t = (41, 0)\nt.Item1")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(41, result.Value)
    }

    @Fact
    func ParenthesizedIndirectCall_RemainsSupported() {
        let result = Evaluate("let increment (int32) -> int32 = (value int32) -> value + 1\n(increment)(41)")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func LeadingDotFloat_RemainsLiteralInPrimaryPosition() {
        let result = Evaluate(".5 + .25")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(0.75, result.Value)
    }

    @Fact
    func ExponentFloatAfterExpression_RemainsSeparateLiteral() {
        let result = Evaluate(`let t = (41, 0)
t
.5e1`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5.0, result.Value)
    }

    @Fact
    func AllDigitLeadingDotAcrossNewline_IsTupleSelector() {
        let result = Evaluate(`let t = (0, 1, 2, 3, 4, 5)
t
.5`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func IntegerAfterExpression_RemainsSeparateLiteral() {
        let result = Evaluate(`let t = (41, 0)
t
10`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(10, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren().OfType[SyntaxNode]() {
                for descendant in Walk(child) {
                    yield descendant
                }
            }
        }
    }
}
