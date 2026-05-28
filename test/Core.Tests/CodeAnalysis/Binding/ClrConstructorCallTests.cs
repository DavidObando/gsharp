// <copyright file="ClrConstructorCallTests.cs" company="GSharp">
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
/// Phase 4 exit — CLR class instantiation at call sites. Covers both
/// non-generic (<c>StringBuilder()</c>) and closed-generic
/// (<c>List[int]()</c>, <c>Dictionary[string, int]()</c>) imports through
/// the new <see cref="BoundClrConstructorCallExpression"/>.
/// </summary>
public class ClrConstructorCallTests
{
    [Fact]
    public void StringBuilder_DefaultConstructor_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var lst = List[int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DictionaryStringInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var d = Dictionary[string, int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_WithCapacityArgument_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder(16)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_TooManyArguments_Diagnoses()
    {
        var source = @"
import System.Text

var sb = StringBuilder(""x"", ""y"", ""z"")
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
