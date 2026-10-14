// <copyright file="AnalysisBridgeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.LanguageServer.Protocol
import GSharp.Repl.Engine
import System.Linq
import Xunit

open class AnalysisBridgeTests {
    @Fact
    func Completions_AfterFunctionDecl_IncludesUserSymbol() {
        let text = "func Greet() string { return \"hi\" }\n"
        let items = AnalysisBridge.Completions(text, 1, 0)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Greet")
    }

    @Fact
    func Hover_OnFunctionName_ReturnsText() {
        let text = "func Greet() string { return \"hi\" }"
        let h string? = AnalysisBridge.Hover(text, 0, 5)
        Assert.False(string.IsNullOrEmpty(h))
    }
}
