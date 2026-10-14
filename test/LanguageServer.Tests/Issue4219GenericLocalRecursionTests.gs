// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Linq
import Xunit

open class Issue4219GenericLocalRecursionTests {
    @Fact
    func ForwardCall_NavigatesToGenericLocalDeclaration() {
        let content = LanguageServerTestHelpers.Content(Source)
        let uri = DocumentUri.From("file:///generic-group.gs")
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri!!,
            content,
            LanguageServerTestHelpers.PositionOf(Source, "second")
        )
        Assert.NotNull(location)
        Assert.Equal(uri, location!!.Uri)
        let expected = LanguageServerTestHelpers.PositionOf(Source, "second", 1)
        Assert.Equal(expected.Line, location!!.Range.Start.Line)
        Assert.Equal(expected.Character, location!!.Range.Start.Character)
    }

    @Theory
    @InlineData("second(")
    @InlineData("second[T](")
    func ForwardCall_HasSignatureHelpAndHover(call string) {
        let source = Source.Replace("second(", call, StringComparison.Ordinal)
        let content = LanguageServerTestHelpers.Content(source)
        let position = LanguageServerTestHelpers.PositionOf(source, call)
        let help SignatureHelp? = SignatureHelpComputer.ComputeSignatureHelp(
            content,
            Position(position.Line, position.Character + call.Length)
        )
        Assert.NotNull(help)
        Assert.Contains("second", Assert.Single(help!!.Signatures).Label, StringComparison.Ordinal)
        Assert.Equal(2, help!!.Signatures.First().Parameters.Count())
        let hover Hover? = HoverComputer.ComputeHover(content, position)
        Assert.NotNull(hover)
        Assert.Contains("second", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func GenericDeclaration_AndShadowingVariableKeepDistinctCachedIdentities() {
        let source = Source.Replace("return first(\"x\", 2)", `{
    let first = 9
    let copied = first
}
return first("x", 2)`, StringComparison.Ordinal)
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        let tokens = SemanticLookup.EnumerateIdentifierTokens(content.SyntaxTree).ToArray()
        let model = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: true)
        let cold = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: false)
        let warm = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: true)
        Assert.All(
            tokens,
            (token SyntaxToken) -> {
                Assert.Same(cold.Resolve(token), model.Resolve(token))
                Assert.Same(model.Resolve(token), warm.Resolve(token))
            }
        )
        let identifiers = tokens.Where((token SyntaxToken) -> token.Text == "first").ToArray()
        Assert.IsType[FunctionSymbol](model.Resolve(identifiers[0]))
        Assert.IsType[LocalVariableSymbol](model.Resolve(identifiers[2]))
        Assert.Same(model.Resolve(identifiers[2]), model.Resolve(identifiers[3]))
        Assert.Same(model.Resolve(identifiers[0]), model.Resolve(identifiers[4]))
    }

    shared {
        private const Source string = `func Run() int32 {
    let first[T] = func(value T, depth int32) int32 {
        return second(value, depth)
    }
    let second[U] = func(value U, depth int32) int32 {
        if depth == 0 { return 42 }
        return first(value, depth - 1)
    }
    return first("x", 2)
}`
    }
}
