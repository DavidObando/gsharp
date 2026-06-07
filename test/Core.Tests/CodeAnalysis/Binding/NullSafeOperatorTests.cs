// <copyright file="NullSafeOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.C.3 — null-safe operators <c>?:</c> (Elvis) and postfix <c>!!</c>
/// (null assertion), plus Phase 3.C.3b null-conditional member access
/// <c>?.</c>.
/// </summary>
public class NullSafeOperatorTests
{
    [Fact]
    public void Elvis_NullLeft_ReturnsRight()
    {
        var source = @"
var x int32? = nil
x ?: 42
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Elvis_NonNullLeft_ReturnsLeft()
    {
        var source = @"
var x int32? = 7
x ?: 42
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void BangBang_NonNull_ReturnsUnderlying()
    {
        var source = @"
var x int32? = 9
x!!
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void BangBang_Null_Throws()
    {
        var source = @"
var x int32? = nil
x!!
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("nil value"));
    }

    [Fact]
    public void NullConditional_NilReceiver_ShortCircuits()
    {
        // BCL string method called via `?.` on a nil receiver returns nil
        // (the whole expression's type becomes string?).
        var source = @"
var s string? = nil
s?.ToUpper() ?: ""fallback""
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("fallback", result.Value);
    }

    [Fact]
    public void NullConditional_NonNilReceiver_EvaluatesAccess()
    {
        var source = @"
var s string? = ""hi""
s?.ToUpper() ?: ""fallback""
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("HI", result.Value);
    }

    [Fact]
    public void BangBang_ChainedMemberAccess_OnNonNilReceiver_BindsAndEvaluates()
    {
        // Issue #518: `expr!!.Member` must bind end-to-end. Models the
        // reduced reproducer (DirectoryInfo.Parent!!.Name) with a
        // string?, which exercises the same parse-tree shape the binder
        // sees: `AccessorExpression(LeftPart = UnaryExpression(!!), RightPart = Name)`.
        var source = @"
import System

var s string? = ""hello""
s!!.Length
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void BangBang_ChainedMethodCall_OnNonNilReceiver_BindsAndEvaluates()
    {
        // `expr!!.Method()` — accessor LeftPart is the `!!` UnaryExpression,
        // RightPart is a CallExpression. Confirms the binder routes the
        // call through the unwrapped receiver.
        var source = @"
import System

var s string? = ""hello""
s!!.ToUpper()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("HELLO", result.Value);
    }

    [Fact]
    public void BangBang_ChainedMemberAccess_OnNilReceiver_Throws()
    {
        // Mirrors PR #541's semantics: when `!!` is applied to a value
        // that is actually nil, evaluation must surface the failure (the
        // chained `.Length` is never reached).
        var source = @"
import System

var s string? = nil
s!!.Length
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("nil value"));
    }

    [Fact]
    public void BangBang_DoubleChain_OnNonNilReceivers_BindsAndEvaluates()
    {
        // `a!!.b!!.c` — two `!!` unwraps interleaved with member access.
        // Each `!!` resumes the postfix chain so the next `.` hangs off
        // the unwrapped value, never the bare name.
        var source = @"
import System

var s string? = ""hello""
var u string? = s!!.ToUpper()
u!!.Length
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void BangBang_ChainedMemberAccess_DirectoryInfoParentName_BindsAndEvaluates()
    {
        // Original reproducer shape from the issue. Picks a path whose
        // parent is guaranteed to exist (we walk to root from a directory
        // we already created); confirms `dir.Parent!!.Name` binds and
        // executes against a CLR `DirectoryInfo`.
        var tempDir = System.IO.Directory.CreateTempSubdirectory("gs_bug518_parent_").FullName;
        try
        {
            var literal = EscapeForGSharpString(tempDir);
            var source = $@"
import System.IO

let dir = DirectoryInfo(""{literal}"")
dir.Parent!!.Name
";
            var result = Evaluate(source);
            Assert.Empty(result.Diagnostics);
            var expected = new System.IO.DirectoryInfo(tempDir).Parent!.Name;
            Assert.Equal(expected, result.Value);
        }
        finally
        {
            try { System.IO.Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void BangBang_ChainedMemberAccess_DirectoryInfoParentName_NullParent_Throws()
    {
        // The complement: when `.Parent` is actually nil (root directory),
        // `dir.Parent!!.Name` must surface the `!!`-on-nil failure
        // (consistent with PR #541), not silently return null and then
        // NRE in `.Name`.
        var rootPath = System.IO.Path.GetPathRoot(System.IO.Directory.GetCurrentDirectory());
        Assert.False(string.IsNullOrEmpty(rootPath), "could not determine filesystem root");
        var literal = EscapeForGSharpString(rootPath);
        var source = $@"
import System.IO

let dir = DirectoryInfo(""{literal}"")
dir.Parent!!.Name
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("nil value"));
    }

    private static string EscapeForGSharpString(string s) =>
        s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
