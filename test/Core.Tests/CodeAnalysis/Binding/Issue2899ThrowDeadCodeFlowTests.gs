// <copyright file="Issue2899ThrowDeadCodeFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import Xunit

/// Issue #2899: definite-return may split at throw, but shared out-parameter
/// analysis must keep its existing opaque exception-flow behavior.
open class Issue2899ThrowDeadCodeFlowTests {
    @Fact
    func ThrowFollowedByDeadCode_DoesNotReportGs0100OrGs0238() {
        const Source = `package Issue2899.ThrowDeadCode
import System

func Value() int32 {
    throw Exception("boom")
    var dead = 1
}

func Assign(out value int32) {
    throw Exception("boom")
    value = 1
}`
        AssertNoErrors(Source)
    }

    @Fact
    func ConditionalReturnAndThrowFollowedByDeadCode_DoesNotReportGs0100() {
        const Source = `package Issue2899.ConditionalThrowDeadCode
import System

func F(condition bool) int32 {
    if condition {
        return 1
    }
    throw Exception("boom")
    var dead = 2
}`
        AssertNoErrors(Source)
    }

    shared {
        private func AssertNoErrors(source string) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
            Assert.True(peStream.Length > int64(0))
        }
    }
}
