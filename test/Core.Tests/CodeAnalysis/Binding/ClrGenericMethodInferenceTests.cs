// <copyright file="ClrGenericMethodInferenceTests.cs" company="GSharp">
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
/// Stream F follow-up — verifies that calls to open generic CLR methods bind
/// after their type arguments are inferred from supplied argument types.
/// </summary>
public class ClrGenericMethodInferenceTests
{
    [Fact]
    public void Enumerable_Repeat_InfersTResultFromArgument()
    {
        // Enumerable.Repeat<TResult>(TResult element, int count); from
        // (int, int) inference picks TResult = int and the call binds without
        // explicit type arguments.
        var source = @"
import System.Linq

let seq = Enumerable.Repeat(7, 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Empty_FailsWithoutInferableArgument()
    {
        // Enumerable.Empty<TResult>() has no arg-driven inference path; the
        // candidate cannot bind without explicit type arguments. The exact
        // diagnostic is "unable to find function" (matches the pre-Stream F
        // behaviour for generic methods with no inferable args).
        var source = @"
import System.Linq

let seq = Enumerable.Empty()
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Repeat_ConflictingArgTypes_DiagnoseAsNotFound()
    {
        // Repeat takes (TResult, int). Passing (int, string) does not match
        // the int second-parameter, so inference succeeds (T=int from arg0)
        // but applicability fails (string is not implicitly int). The call
        // does not bind.
        var source = @"
import System.Linq

let seq = Enumerable.Repeat(7, ""three"")
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Count_InfersTFromSlice()
    {
        // #611: Enumerable.Count<T>(IEnumerable<T>) must infer T from a
        // []string argument. The CLR-level UnifyForInference walks the
        // array's interfaces to find IEnumerable<string>.
        var source = @"
import System.Linq

var s = []string{""a"", ""b""}
let n = Enumerable.Count(s)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Contains_InfersTFromSlice()
    {
        // #611: Enumerable.Contains<T>(IEnumerable<T>, T) infers T from a
        // []int32 slice argument.
        var source = @"
import System.Linq

var s = []int32{1, 2, 3}
let found = Enumerable.Contains(s, 2)
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
