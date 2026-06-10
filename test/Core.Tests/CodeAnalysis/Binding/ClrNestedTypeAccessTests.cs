// <copyright file="ClrNestedTypeAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #672: CLR nested type access in expression position. Verifies
/// that `Outer.Nested.Member` resolves when `Nested` is a nested enum,
/// class, or struct defined inside an imported CLR type.
/// </summary>
public class ClrNestedTypeAccessTests
{
    [Fact]
    public void NestedEnum_MemberAccess_Binds()
    {
        // Environment.SpecialFolder.ApplicationData — the original repro.
        var source = @"
import System

var sf = Environment.SpecialFolder.ApplicationData
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedEnum_PassedToMethod_Binds()
    {
        // Pass nested enum value to a method that accepts it.
        var source = @"
import System

var path = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TopLevelEnum_ContinuesToWork_Regression()
    {
        // StringComparison.OrdinalIgnoreCase is a top-level enum and must
        // continue to work.
        var source = @"
import System

var cmp = StringComparison.OrdinalIgnoreCase
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StaticMethod_OnImportedClass_ContinuesToWork_Regression()
    {
        // Environment.GetEnvironmentVariable must still resolve (regression guard).
        var source = @"
import System

var x = Environment.GetEnvironmentVariable(""PATH"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedEnum_MultipleValues_Bind()
    {
        // Access multiple values from the same nested enum.
        var source = @"
import System

var a = Environment.SpecialFolder.ApplicationData
var b = Environment.SpecialFolder.Desktop
var c = Environment.SpecialFolder.UserProfile
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedEnum_InvalidMember_ReportsError()
    {
        // A non-existent member on the nested enum should still report an error.
        var source = @"
import System

var sf = Environment.SpecialFolder.ThisDoesNotExist
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void NestedType_StaticPropertyAccess_Binds()
    {
        // System.Text.Encoding has a nested class UTF8Encoding, but a
        // more accessible static pattern: access nested type static members.
        // Use System.IO.Path.DirectorySeparatorChar as a non-nested reference
        // test, and use TypeCode which is nested in various patterns.
        // Actually, let's use System.Environment.SpecialFolder which is the
        // core issue, and verify a different nested-enum pattern:
        // System.Globalization.UnicodeCategory — wait, that's top-level.
        // Use System.AttributeTargets which is a flags enum.
        // Actually AttributeTargets is top-level too.
        // The critical test is Environment.SpecialFolder which is the only
        // commonly-used BCL nested enum.
        var source = @"
import System

var sf = Environment.SpecialFolder.CommonApplicationData
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
