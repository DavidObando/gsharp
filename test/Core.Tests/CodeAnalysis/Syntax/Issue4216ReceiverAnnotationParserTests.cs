// <copyright file="Issue4216ReceiverAnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #4216: ADR-0047 receiver-parameter annotations must survive the
/// receiver-clause lookahead and attach to parameter zero.
/// </summary>
public class Issue4216ReceiverAnnotationParserTests
{
    [Fact]
    public void ParsesAnnotatedExtensionReceiver()
    {
        var tree = SyntaxTree.Parse("""
            package P
            import System.Diagnostics.CodeAnalysis

            func (@NotNullWhen(false) value string?) IsMissing() bool {
                return value == nil
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.NotNull(function.Receiver);
        Assert.Single(function.Receiver!.Annotations);
        Assert.Equal("NotNullWhen", function.Receiver.Annotations[0].NameSegments.Single().Text);
    }

    [Fact]
    public void ParsesReceiverAnnotationWithKeywordTarget()
    {
        // `param` is a plain identifier but `return`/`type` are reserved
        // keywords the annotation grammar accepts contextually before ':'.
        // The receiver-clause lookahead must use the same grammar or it
        // rejects the clause and cascades bogus syntax errors.
        var tree = SyntaxTree.Parse("""
            package P
            import System.Diagnostics.CodeAnalysis

            func (@param:NotNullWhen(false) value string?) IsMissing() bool {
                return value == nil
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.NotNull(function.Receiver);
        Assert.Equal("param", function.Receiver!.Annotations[0].Target!.KindIdentifier.Text);
    }

    [Fact]
    public void ReceiverClauseLookaheadAcceptsReservedKeywordTarget()
    {
        // `return` is a valid annotation target kind, but the lexer never
        // demotes it to an identifier. The lookahead must accept it so the
        // clause is still read as a receiver; whether the target is legal in
        // this position is a later, separate concern.
        var tree = SyntaxTree.Parse("""
            package P

            func (@return:Foo value string?) IsMissing() bool {
                return value == nil
            }
            """);

        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.NotNull(function.Receiver);
        Assert.Equal("return", function.Receiver!.Annotations[0].Target!.KindIdentifier.Text);
    }
}
