// <copyright file="Issue4216ReceiverAnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #4216: ADR-0047 receiver-parameter annotations must survive the
/// receiver-clause lookahead and attach to parameter zero.
open class Issue4216ReceiverAnnotationParserTests {
    @Fact
    func ParsesAnnotatedExtensionReceiver() {
        let tree = SyntaxTree.Parse(`package P
import System.Diagnostics.CodeAnalysis

func (@NotNullWhen(false) value string?) IsMissing() bool {
    return value == nil
}`)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.NotNull(function.Receiver)
        Assert.Single(function.Receiver!!.Annotations)
        Assert.Equal("NotNullWhen", function.Receiver!!.Annotations[0].NameSegments.Single().Text)
    }

    @Fact
    func ParsesReceiverAnnotationWithKeywordTarget() {
        // `param` is a plain identifier but `return`/`type` are reserved
        // keywords the annotation grammar accepts contextually before ':'.
        // The receiver-clause lookahead must use the same grammar or it
        // rejects the clause and cascades bogus syntax errors.
        let tree = SyntaxTree.Parse(`package P
import System.Diagnostics.CodeAnalysis

func (@param:NotNullWhen(false) value string?) IsMissing() bool {
    return value == nil
}`)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.NotNull(function.Receiver)
        Assert.Equal("param", function.Receiver!!.Annotations[0].Target!!.KindIdentifier.Text)
    }

    @Fact
    func ReceiverClauseLookaheadAcceptsReservedKeywordTarget() {
        // `return` is a valid annotation target kind, but the lexer never
        // demotes it to an identifier. The lookahead must accept it so the
        // clause is still read as a receiver; whether the target is legal in
        // this position is a later, separate concern.
        let tree = SyntaxTree.Parse(`package P

func (@return:Foo value string?) IsMissing() bool {
    return value == nil
}`)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.NotNull(function.Receiver)
        Assert.Equal("return", function.Receiver!!.Annotations[0].Target!!.KindIdentifier.Text)
    }
}
