// <copyright file="Issue1199ImportedCompositeLiteralBinderTests.cs" company="GSharp">
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
/// Issue #1199: a composite literal <c>T{Member: value}</c> must also resolve
/// and assign settable members on an IMPORTED reference-type class (a BCL
/// class such as <c>System.Text.StringBuilder</c>) — exactly the cases that
/// already work in constructor-call position. A read-only / get-only member is
/// still not settable, and an unknown member is still diagnosed.
/// </summary>
public class Issue1199ImportedCompositeLiteralBinderTests
{
    [Fact]
    public void ImportedClassLiteral_SettableProperty_BindsAndEvaluates()
    {
        var source = @"
import System.Text

let sb = StringBuilder{Capacity: 128}
sb.Capacity
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(128, result.Value);
    }

    [Fact]
    public void ImportedClassLiteral_NoInitializers_Binds()
    {
        var source = @"
import System.Text

let sb = StringBuilder{}
sb.Capacity
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedClassLiteral_GetOnlyMember_IsDiagnosed()
    {
        var source = @"
import System.Text

let sb = StringBuilder{MaxCapacity: 5}
sb.MaxCapacity
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("read-only"));
    }

    [Fact]
    public void ImportedClassLiteral_UnknownMember_IsDiagnosed()
    {
        var source = @"
import System.Text

let sb = StringBuilder{Missing: 5}
sb.Capacity
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member"));
    }

    [Fact]
    public void ImportedClassLiteral_DuplicateMember_IsDiagnosed()
    {
        var source = @"
import System.Text

let sb = StringBuilder{Capacity: 16, Capacity: 32}
sb.Capacity
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
