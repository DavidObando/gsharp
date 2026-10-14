// <copyright file="Issue3286FunctionPointerNilComparisonBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.IO
import System.Linq
import Xunit

/// Issue #3286: function-pointer comparisons only accept native-pointer operands.
open class Issue3286FunctionPointerNilComparisonBinderTests {
    @Theory
    @InlineData("fp == \"x\"", "==")
    @InlineData("\"x\" != fp", "!=")
    func FunctionPointerComparedWithNonPointer_ReportsGS0129(expression string, operatorText string) {
        let tree = SyntaxTree.Parse(SourceText.From((`package P

unsafe func run() {
    var fp *func(int32) int32 = nil
    var bad = ` + "$expression" + `
}`)))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let diagnostic = Assert.Single(compilation.Emit(peStream).Diagnostics.Where((d Diagnostic) -> d.Id == "GS0129"))
        Assert.Equal(operatorText, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }
}
