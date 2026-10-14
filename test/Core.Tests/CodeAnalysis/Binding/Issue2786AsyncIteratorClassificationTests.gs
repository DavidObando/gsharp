// <copyright file="Issue2786AsyncIteratorClassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit

class Issue2786AsyncIteratorClassificationTests {
    @Fact
    func ExplicitAsyncIteratorFunctionLiteral_ReportsGS0497() {
        let compilation = Compile(`package Issue2786.Literal
import System.Collections.Generic
import System.Threading.Tasks

let values = async func() IAsyncEnumerable[int32] {
    await Task.CompletedTask
}`)
        Assert.Contains(compilation.GlobalScope.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0497")
    }

    @Fact
    func ExplicitAsyncIteratorArrowLiteral_ReportsGS0497() {
        let compilation = Compile(`package Issue2786.Arrow
import System.Collections.Generic

async func Values() IAsyncEnumerable[int32] {
    yield 1
}

let values = async () -> Values()`)
        Assert.Contains(compilation.GlobalScope.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0497")
    }

    shared {
        private func Compile(source string) Compilation -> Compilation(SyntaxTree.Parse(SourceText.From(source)))
    }
}
