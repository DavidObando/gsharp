// <copyright file="Issue4967NullCoalescingAssignmentHoverTests.cs" company="GSharp">
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

/// Issue #4967: the language server resolves names inside a value-position
/// `??=` and hovers the binding it initializes with the expression's type.
open class Issue4967NullCoalescingAssignmentHoverTests {
    @Fact
    func TargetAndResult_ResolveAndHover() {
        let content = LanguageServerTestHelpers.Content(Source)
        let compilation = Compilation(content.SyntaxTree)
        let model = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: false)
        let targets = SemanticLookup
            .EnumerateIdentifierTokens(content.SyntaxTree)
            .Where((token SyntaxToken) -> token.Text == "cached")
            .ToArray()
        Assert.Equal(3, targets.Length)
        let declared = Assert.IsType[LocalVariableSymbol](model.Resolve(targets[0]))
        Assert.Same(declared, model.Resolve(targets[1]))
        Assert.Same(declared, model.Resolve(targets[2]))
        let targetHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(Source, "cached ??=")
        )
        Assert.NotNull(targetHover)
        Assert.Contains("string?", targetHover!!.Contents.ToString(), StringComparison.Ordinal)
        let resultHover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(Source, "name")
        )
        Assert.NotNull(resultHover)
        let resultText = resultHover!!.Contents.ToString()
        Assert.Contains("name", resultText, StringComparison.Ordinal)
        Assert.Contains("string", resultText, StringComparison.Ordinal)
        Assert.DoesNotContain("string?", resultText, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `func Run() int32 {
    var cached string? = nil
    let name = (cached ??= "computed")
    return name.Length + (cached ??= "x").Length
}`
    }
}
