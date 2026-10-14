// <copyright file="Issue792ThrowAsTerminatorTests.cs" company="GSharp">
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

/// Issue #792 / ADR-0084. `throw` statements transfer control out of
/// the current function frame (to a catch handler or off the frame
/// entirely) and are therefore terminators of their CFG basic block.
/// The `AllPathsReturn` check that powers GS0100 ("Not all code
/// paths return a value") used to demand the last statement of every
/// branch into End be a `ReturnStatement`; that wrongly rejected
/// functions where one branch threw and the other returned. Without
/// this fix the trivial G# spelling of helpers like
/// `Optional.OrThrow` won't bind.
open class Issue792ThrowAsTerminatorTests {
    @Fact
    func ThrowInIfBranch_FollowedByReturn_DoesNotReport_AllPathsMustReturn() {
        const Source = `package Issue792.Throw

import System

func OrThrow(self string) string {
    if self == nil {
        throw InvalidOperationException("missing")
    }
    return self
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let emitResult = compilation.Emit(peStream)
        Assert.DoesNotContain(emitResult.Diagnostics, (d Diagnostic) -> d.Id == "GS0100")
    }

    @Fact
    func ThrowAsOnlyPath_DoesNotReport_AllPathsMustReturn() {
        const Source = `package Issue792.ThrowOnly

import System

func MustFail(message string) string {
    throw InvalidOperationException(message)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let emitResult = compilation.Emit(peStream)
        Assert.DoesNotContain(emitResult.Diagnostics, (d Diagnostic) -> d.Id == "GS0100")
    }

    @Fact
    func MissingReturn_OnNonThrowPath_StillReports_AllPathsMustReturn() {
        const Source = `package Issue792.Negative

import System

func Half(x int32) int32 {
    if x > 0 {
        return x
    }
    // Falls off the end — no throw, no return. GS0100 must still fire.
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let emitResult = compilation.Emit(peStream)
        Assert.Contains(emitResult.Diagnostics, (d Diagnostic) -> d.Id == "GS0100")
    }
}
