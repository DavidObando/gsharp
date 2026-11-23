// <copyright file="Issue5957IncrementDecrementFormattingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import GSharp.Gsfmt
import System
import System.IO
import System.Linq
import Xunit

/// Issue #5957: prefix `++` and `--` attach tightly to their operands, remain
/// spaced from preceding tokens, round-trip without synthetic child-order
/// rejections (`GSF0001`), and stay idempotent alongside postfix controls.
class Issue5957IncrementDecrementFormattingTests {
    @Fact
    func ReproCounter_FormatsPrefixIncrementInitializersCleanlyAndIdempotently() {
        const source = `class Counter {
    private var count int32 = 0

    func Next() int32 {
        let value = ++this.count
        return value
    }
}
`
        let once = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(once.Diagnostics)
        Assert.False(once.Changed)
        Assert.Equal(source, once.Text!!.ToString())

        let unformatted = `class Counter {
    private var count int32 = 0

    func Next() int32 {
        let value=++ this.count
        return value
    }
}
`
        let formatted = GSharpFormatter.Format(SourceText.From(unformatted))
        Assert.Empty(formatted.Diagnostics)
        Assert.True(formatted.Changed)
        Assert.Equal(source, formatted.Text!!.ToString())

        let twice = GSharpFormatter.Format(formatted.Text!!)
        Assert.Empty(twice.Diagnostics)
        Assert.False(twice.Changed)
        Assert.Equal(source, twice.Text!!.ToString())
    }

    @Fact
    func PrefixAndPostfixIncrementDecrement_FormatInAllExpressionAndStatementContexts() {
        const source = `func use(arr[]int32, p *int32, flag bool) int32 {
    var x = 0
    var y = 10
    let a = ++ x
    let b = -- y
    let c = x ++
    let d = y --
    a = ++ x
    b = -- y
    let callPrefix = f(++ x, -- y)
    let callPostfix = f(x ++, y --)
    let idxPrefix = arr[++ x]
    let idxPostfix = arr[y --]
    let elemPrefix = ++ arr[0]
    let elemCanon = ++arr[0]
    let elemDec = -- arr[1]
    let elemPostfix = arr[0] --
    let ptrPrefix = ++ *p
    let ptrPostfix = (*p) --
    let parenTarget = ++ (x)
    let parenExpr = (++ x) + (y --)
    let negDec = - -- x
    let ternary = flag ? ++ x : -- y
    let items = []int32{++ x, -- y, x ++, y --}
    ++ x
    -- y
    x ++
    y --
    for var i = 0; i < 10; ++ i {
        continue
    }
    for var j = 10; j > 0; j -- {
        break
    }
    return -- x
}
`
        const expected = `func use(arr[]int32, p *int32, flag bool) int32 {
    var x = 0
    var y = 10
    let a = ++x
    let b = --y
    let c = x++
    let d = y--
    a = ++x
    b = --y
    let callPrefix = f(++x, --y)
    let callPostfix = f(x++, y--)
    let idxPrefix = arr[++x]
    let idxPostfix = arr[y--]
    let elemPrefix = ++arr[0]
    let elemCanon = ++arr[0]
    let elemDec = --arr[1]
    let elemPostfix = arr[0]--
    let ptrPrefix = ++*p
    let ptrPostfix = (*p)--
    let parenTarget = ++(x)
    let parenExpr = (++x) + (y--)
    let negDec = - --x
    let ternary = flag ? ++x : --y
    let items = []int32{++x, --y, x++, y--}
    ++x
    --y
    x++
    y--
    for var i = 0; i < 10; ++i {
        continue
    }
    for var j = 10; j > 0; j-- {
        break
    }
    return --x
}
`
        let beforeTree = SyntaxTree.Parse(source)
        Assert.Empty(beforeTree.Diagnostics)

        let once = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(once.Diagnostics)
        let formatted = once.Text!!.ToString()
        Assert.Equal(expected, formatted)

        let afterTree = SyntaxTree.Parse(once.Text!!)
        Assert.Empty(afterTree.Diagnostics)
        Assert.Equal(SignificantTokens(source), SignificantTokens(formatted))
        let beforeSummary = IncrementDecrementSummary(beforeTree.Root)
        let afterSummary = IncrementDecrementSummary(afterTree.Root)
        Assert.NotEmpty(beforeSummary)
        Assert.Contains(beforeSummary, (entry string) -> entry.StartsWith("Event:", StringComparison.Ordinal))
        Assert.Contains(beforeSummary, (entry string) -> entry.StartsWith("Index:", StringComparison.Ordinal))
        Assert.Contains(beforeSummary, (entry string) -> entry.StartsWith("Indirect:", StringComparison.Ordinal))
        Assert.Equal(beforeSummary, afterSummary)

        let twice = GSharpFormatter.Format(once.Text!!)
        Assert.Empty(twice.Diagnostics)
        Assert.False(twice.Changed)
        Assert.Equal(formatted, twice.Text!!.ToString())
    }

    @Fact
    func PrefixAndPostfixIncrementDecrement_PreserveCommentsAndRoundTrip() {
        const source = `class Counter {
    private var count int32 = 0

    func Next() int32 {
        let beforePrefix = /* before */ ++ this.count
        let midPrefix = ++ /* mid */ this.count
        let trailPrefix = ++ this.count // trailing prefix
        let beforePostfix = /* before */ this.count ++
        let trailPostfix = this.count ++ // trailing postfix
        return -- this.count
    }
}
`
        let once = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(once.Diagnostics)
        let text = once.Text!!.ToString()
        Assert.Contains("let beforePrefix = /* before */ ++this.count", text, StringComparison.Ordinal)
        Assert.Contains("let midPrefix = ++/* mid */ this.count", text, StringComparison.Ordinal)
        Assert.Contains("let trailPrefix = ++this.count // trailing prefix", text, StringComparison.Ordinal)
        Assert.Contains("let beforePostfix = /* before */ this.count++", text, StringComparison.Ordinal)
        Assert.Contains("let trailPostfix = this.count++ // trailing postfix", text, StringComparison.Ordinal)
        Assert.Contains("return --this.count", text, StringComparison.Ordinal)

        let twice = GSharpFormatter.Format(once.Text!!)
        Assert.Empty(twice.Diagnostics)
        Assert.False(twice.Changed)
        Assert.Equal(text, twice.Text!!.ToString())
    }

    @Fact
    func GsfmtCli_CheckAndWriteRoundTripPrefixAndPostfixIncrementDecrement() {
        let root = Directory.CreateTempSubdirectory("gsfmt-issue5957-").FullName
        let file = Path.Combine(root, "Counter.gs")
        const unformatted = `class Counter {
    private var count int32 = 0

    func Next() int32 {
        let value=++ this.count
        let prev=this.count++
        return value + prev
    }
}
`
        const canonical = `class Counter {
    private var count int32 = 0

    func Next() int32 {
        let value = ++this.count
        let prev = this.count++
        return value + prev
    }
}
`
        try {
            File.WriteAllText(file, unformatted)

            let checkBeforeOut = StringWriter()
            let checkBeforeErr = StringWriter()
            Assert.Equal(1, Program.Run([]string{"--check", file}, checkBeforeOut, checkBeforeErr))
            Assert.Equal(file + "\n", checkBeforeOut.ToString().Replace("\r\n", "\n"))

            let writeOut = StringWriter()
            let writeErr = StringWriter()
            Assert.Equal(0, Program.Run([]string{"--write", file}, writeOut, writeErr))
            Assert.Equal(string.Empty, writeErr.ToString())
            Assert.Equal(canonical, File.ReadAllText(file))

            let checkAfterOut = StringWriter()
            let checkAfterErr = StringWriter()
            Assert.Equal(0, Program.Run([]string{"--check", file}, checkAfterOut, checkAfterErr))
            Assert.Equal(string.Empty, checkAfterOut.ToString())
            Assert.Equal(string.Empty, checkAfterErr.ToString())
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private func SignificantTokens(source string)[]string -> SyntaxTree
            .ParseTokens(source)
            .Where(
            (token SyntaxToken) -> !(
                token.Kind is SyntaxKind.WhitespaceToken or
                    SyntaxKind.CommentToken or
                    SyntaxKind.DocumentationCommentToken
            )
        )
            .Select((token SyntaxToken) -> token.Kind.ToString() + ":" + token.Text)
            .ToArray()

        private func IncrementDecrementSummary(root SyntaxNode)[]string -> root
            .DescendantNodesAndSelf()
            .Select(
            (node SyntaxNode) -> switch node {
                case ev is EventSubscriptionExpressionSyntax when ev.IsIncrementDecrement:
                "Event:" + ev.OperatorToken.Text + ":" + ev.ReturnsPreviousValue.ToString() +
                    ":" +
                    ev.LeftHandSide.Kind.ToString()
                case idx is CompoundIndexAssignmentExpressionSyntax when idx.IsIncrementDecrement:
                "Index:" + idx.OperatorToken.Text + ":" + idx.ReturnsPreviousValue.ToString() +
                    ":" +
                    idx.Target.Kind.ToString()
                case ind is IndirectCompoundAssignmentExpressionSyntax when ind.IsIncrementDecrement:
                "Indirect:" + ind.OperatorToken.Text + ":" + ind.ReturnsPreviousValue.ToString() +
                    ":" +
                    ind.Target.Kind.ToString()
                default: ""
            }
        )
            .Where((entry string) -> entry.Length > 0)
            .ToArray()
    }
}
