// <copyright file="Issue792ThrowAsTerminatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #792 / ADR-0084. <c>throw</c> statements transfer control out of
/// the current function frame (to a catch handler or off the frame
/// entirely) and are therefore terminators of their CFG basic block.
/// The <c>AllPathsReturn</c> check that powers GS0100 ("Not all code
/// paths return a value") used to demand the last statement of every
/// branch into End be a <c>ReturnStatement</c>; that wrongly rejected
/// functions where one branch threw and the other returned. Without
/// this fix the trivial G# spelling of helpers like
/// <c>Optional.OrThrow</c> won't bind.
/// </summary>
public class Issue792ThrowAsTerminatorTests
{
    [Fact]
    public void ThrowInIfBranch_FollowedByReturn_DoesNotReport_AllPathsMustReturn()
    {
        const string Source = @"package Issue792.Throw

import System

func OrThrow(self string) string {
    if self == nil {
        throw InvalidOperationException(""missing"")
    }
    return self
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);

        using var peStream = new System.IO.MemoryStream();
        var emitResult = compilation.Emit(peStream);

        Assert.DoesNotContain(emitResult.Diagnostics, d => d.Id == "GS0100");
    }

    [Fact]
    public void ThrowAsOnlyPath_DoesNotReport_AllPathsMustReturn()
    {
        const string Source = @"package Issue792.ThrowOnly

import System

func MustFail(message string) string {
    throw InvalidOperationException(message)
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);

        using var peStream = new System.IO.MemoryStream();
        var emitResult = compilation.Emit(peStream);

        Assert.DoesNotContain(emitResult.Diagnostics, d => d.Id == "GS0100");
    }

    [Fact]
    public void MissingReturn_OnNonThrowPath_StillReports_AllPathsMustReturn()
    {
        const string Source = @"package Issue792.Negative

import System

func Half(x int32) int32 {
    if x > 0 {
        return x
    }
    // Falls off the end — no throw, no return. GS0100 must still fire.
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);

        using var peStream = new System.IO.MemoryStream();
        var emitResult = compilation.Emit(peStream);

        Assert.Contains(emitResult.Diagnostics, d => d.Id == "GS0100");
    }
}
