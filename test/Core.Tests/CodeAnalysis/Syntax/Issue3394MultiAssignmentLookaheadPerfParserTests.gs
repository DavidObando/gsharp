// <copyright file="Issue3394MultiAssignmentLookaheadPerfParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Diagnostics
import System.Text
import Xunit

/// Issue #3394: multi-assignment speculation must not recursively parse every
/// block-lambda body in an ordinary expression statement.
open class Issue3394MultiAssignmentLookaheadPerfParserTests {
    @Fact
    func DeeplyNestedBlockLambdaCalls_ParseQuickly() {
        const nestingDepth = 22
        let body = StringBuilder("Use()")
        for var i = 0; i < nestingDepth; i++ {
            body.Insert(0, "Sink(() -> {\n")
            body.Append("\n})")
        }
        let source = `package p
func F() {
` + body.ToString() + `
}
`
        SyntaxTree.Parse("package p\nfunc Warmup() { Use() }")
        let stopwatch = Stopwatch.StartNew()
        let tree = SyntaxTree.Parse(source)
        stopwatch.Stop()
        Assert.Empty(tree.Diagnostics)
        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(5),
            "Parsing $nestingDepth nested block-lambda calls took " +
                "${stopwatch.ElapsedMilliseconds}ms, expected < 5000ms."
        )
    }
}
