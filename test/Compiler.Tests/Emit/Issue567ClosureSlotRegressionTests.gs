// <copyright file="Issue567ClosureSlotRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.IO
import System.Linq
import Xunit

/// Issue #567 regression guard: verifies that programs involving closures
/// inside for-in loops compile cleanly without silent emit failures. If the
/// underlying closure lowering bug resurfaces, the emit invariant ensures a
/// structured `GS9998` diagnostic would appear (tested separately in
/// `SilentEmitFailureInvariantTests`).
open class Issue567ClosureSlotRegressionTests {
    @Fact
    func ClosureInsideForIn_CompilesSuccessfully() {
        // This pattern exercises closures inside for-in loops. If the
        // underlying closure lowering bug resurfaces (issue #567), the
        // emit invariant catches it with a structured GS9998 diagnostic.
        let source = `package Test
import System
import System.Collections.Generic

var items = List[string]()
items.Add("a")
items.Add("b")
items.Add("c")

var n = 0
for s in items {
    n = n + 1
}

Console.WriteLine(n)`
        let sourceText = SourceText.From(source, "issue567_closure_test.gs")
        let tree = SyntaxTree.Parse(sourceText)
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream, refStream: nil)
        Assert.True(
            result.Success,
            "Expected successful compilation; got: " + string.Join(
                "; ",
                result.Diagnostics.Select((d Diagnostic) -> "[${d.Id}] ${d.Message}")
            )
        )
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }
}
