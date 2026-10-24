// <copyright file="Issue5277SynthesizedTokenSpanTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #5277: a token the parser synthesizes to complete a desugared form carries text but is
/// not written in source, so its span is zero-width and never reaches into the next token or declaration.
open class Issue5277SynthesizedTokenSpanTests {
    /// A body-less `data class` ends where its header ends. Its span used to include the first
    /// character of the declaration that follows.
    @Fact
    func BodylessDataClass_SpanDoesNotCoverTheNextDeclaration() {
        let source = "package p\ndata class P(X int32)\nfunc F() { }\n"
        let tree = SyntaxTree.Parse(source)
        let declarations = tree.Root.Members.OfType[StructDeclarationSyntax]().ToList()
        Assert.Equal(1, declarations.Count)
        let span = declarations[0].Span
        Assert.Equal("data class P(X int32)", source.Substring(span.Start, span.Length))
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(span.End <= function.Span.Start, "the type's span reaches the next declaration")
    }

    /// Two body-less types in a row do not overlap.
    @Fact
    func BodylessTypes_InARow_DoNotOverlap() {
        let source = "package p\nstruct A(X int32)\nclass B(Y int32)\nstruct C(Z int32)\n"
        let tree = SyntaxTree.Parse(source)
        let types = tree.Root.Members.OfType[StructDeclarationSyntax]().ToList()
        Assert.Equal(3, types.Count)
        for var i = 1; i < types.Count; i++ {
            Assert.True(types[i - 1].Span.End <= types[i].Span.Start, "type ${i - 1} overlaps type $i")
        }
        Assert.Equal("class B(Y int32)", source.Substring(types[1].Span.Start, types[1].Span.Length))
    }

    /// The synthesized braces keep their text and are not missing, but have no width.
    @Fact
    func BodylessBraces_HaveTextAndNoWidth() {
        let tree = SyntaxTree.Parse("package p\ndata class P(X int32)\nfunc F() { }\n")
        let type = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Equal("{", type.OpenBraceToken.Text)
        Assert.Equal("}", type.CloseBraceToken.Text)
        Assert.False(type.OpenBraceToken.IsMissing)
        Assert.Equal(0, type.OpenBraceToken.Span.Length)
        Assert.Equal(0, type.CloseBraceToken.Span.Length)
    }

    /// The `return` of an expression body is zero-width and ends before the expression it returns.
    @Fact
    func ExpressionBody_ReturnKeywordIsZeroWidth() {
        let source = "package p\nfunc F() int32 -> 42\n"
        let tree = SyntaxTree.Parse(source)
        let statement = Descendants(tree.Root).OfType[ReturnStatementSyntax]().Single()
        Assert.Equal("return", statement.ReturnKeyword.Text)
        Assert.Equal(0, statement.ReturnKeyword.Span.Length)
        Assert.True(statement.ReturnKeyword.Span.End <= statement.Expression!!.Span.Start)
    }

    /// The `()` of `T{...}` is zero-width.
    @Fact
    func CollectionInitializer_SynthesizedParenthesesAreZeroWidth() {
        let tree = SyntaxTree.Parse("package p\nfunc F() { let l = List[int32]{ 1, 2 } }\n")
        let call = Descendants(tree.Root).OfType[CallExpressionSyntax]().Single()
        Assert.Equal("(", call.OpenParenthesisToken.Text)
        Assert.Equal(0, call.OpenParenthesisToken.Span.Length)
        Assert.Equal(0, call.CloseParenthesisToken.Span.Length)
    }

    /// `i++` and `i--` keep the written operator in their span.
    @Fact
    func PostfixIncrement_SpanCoversTheWrittenOperator() {
        let source = "package p\nfunc F() { var i = 0\ni++\ni--\n--i }\n"
        let tree = SyntaxTree.Parse(source)
        let texts = List[string]()
        for node in Descendants(tree.Root) {
            if node is EventSubscriptionExpressionSyntax {
                texts.Add(source.Substring(node.Span.Start, node.Span.Length))
            }
        }
        Assert.Equal("i++,i--,--i", string.Join(",", texts))
    }

    private func Descendants(root SyntaxNode) sequence[SyntaxNode] {
        let stack = Stack[SyntaxNode]()
        stack.Push(root)
        while stack.Count > 0 {
            let node = stack.Pop()
            yield node
            for var i = node.ChildCount - 1; i >= 0; i-- {
                stack.Push(node.GetChild(i))
            }
        }
    }
}
