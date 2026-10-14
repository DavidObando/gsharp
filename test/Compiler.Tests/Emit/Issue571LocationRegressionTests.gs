// <copyright file="Issue571LocationRegressionTests.cs" company="GSharp">
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

/// Issue #571 regression guard: verifies that programs involving nullable
/// value-type implicit lifts compile cleanly. If the underlying emit path
/// fails in the future, the invariant ensures a structured `GS9998`
/// diagnostic anchored at the call site (tested separately in
/// `SilentEmitFailureInvariantTests`).
open class Issue571LocationRegressionTests {
    @Fact
    func NullableValueTypeLift_CompilesSuccessfully() {
        // This pattern exercises nullable value-type operations that
        // previously risked silent emit failures (issue #571).
        let source = `package Test
import System

var x int32? = 42
var y int32? = nil
var v int32 = x ?? 0
Console.WriteLine(v)
Console.WriteLine(y)`
        let sourceText = SourceText.From(source, "issue571_location_test.gs")
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
