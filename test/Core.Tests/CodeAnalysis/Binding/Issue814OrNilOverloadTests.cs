// <copyright file="Issue814OrNilOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #814 / ADR-0084 §L5 closing bullet — disambiguation of two
/// extension overloads that share a shape-identical receiver type
/// (<c>(self sequence[T])</c>) and parameter list, distinguished only
/// by a <c>class</c> / <c>struct</c> generic-parameter constraint and a
/// return-type representation that bottoms out in <c>T?</c>. The
/// canonical surface is <see cref="System.Linq"/>-style
/// <c>FirstOrNil</c> / <c>LastOrNil</c> / <c>SingleOrNil</c>.
/// </summary>
public class Issue814OrNilOverloadTests
{
    [Fact]
    public void FirstOrNil_TwoOverloadsCoexist_NoDuplicateDeclarationDiagnostic()
    {
        // Both overloads must declare cleanly even though their declared
        // receiver shape (`sequence[T]`) is structurally identical — the
        // T in each is a different TypeParameterSymbol with a disjoint
        // constraint, so they are distinct extension entries.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? { return nil }
func (self sequence[T]) FirstOrNil[T struct]() T? { return nil }
";
        Assert.Empty(GetErrorDiagnostics(source));
    }

    [Fact]
    public void FirstOrNil_OnStringArray_ResolvesClassOverload()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() string { return ""class"" }
func (self sequence[T]) FirstOrNil[T struct]() string { return ""struct"" }

let arr = []string{}
let tag = arr.FirstOrNil()
tag
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("class", result.Value);
    }

    [Fact]
    public void FirstOrNil_OnInt32Array_ResolvesStructOverload()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() string { return ""class"" }
func (self sequence[T]) FirstOrNil[T struct]() string { return ""struct"" }

let arr = []int32{}
let tag = arr.FirstOrNil()
tag
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("struct", result.Value);
    }

    [Fact]
    public void FirstOrNil_ReturnTypeIsTQuestion_ResolvesClassOverloadForStrings()
    {
        // The actual ADR-0084 §L5 shape: return type is `T?`. The class
        // overload returns a reference-typed `T?`; the struct overload
        // returns a `Nullable<T>`. Pre-fix the two overloads were both
        // declared but the binder's tie-break could not pick a winner
        // when the only distinguishing constraint was class/struct on
        // the receiver type-parameter.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

let strs = []string{ ""alpha"", ""beta"" }
let head = strs.FirstOrNil() ?: ""<none>""
head
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("alpha", result.Value);
    }

    [Fact]
    public void FirstOrNil_ReturnTypeIsTQuestion_ResolvesStructOverloadForInt32()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

let nums = []int32{ 11, 22, 33 }
let head = nums.FirstOrNil() ?: -1
head
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void LastOrNil_TwoOverloadsCoexist_AndDispatchByConstraint()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) LastOrNil[T class]() string { return ""class"" }
func (self sequence[T]) LastOrNil[T struct]() string { return ""struct"" }

let arr1 = []string{ ""a"" }
let arr2 = []int32{ 1 }
arr1.LastOrNil() + arr2.LastOrNil()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("classstruct", result.Value);
    }

    [Fact]
    public void SingleOrNil_TwoOverloadsCoexist_AndDispatchByConstraint()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) SingleOrNil[T class]() string { return ""class"" }
func (self sequence[T]) SingleOrNil[T struct]() string { return ""struct"" }

let arr1 = []string{ ""a"" }
let arr2 = []int32{ 1 }
arr1.SingleOrNil() + arr2.SingleOrNil()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("classstruct", result.Value);
    }

    [Fact]
    public void TwoOverloads_OnlyOneMatchesConstraint_PicksUnambiguously()
    {
        // Only the class overload is declared; calling on an int32
        // array must diagnose because neither candidate satisfies a
        // struct argument.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

let nums = []int32{ 1, 2, 3 }
let head = nums.FirstOrNil()
head
";
        // The lookup falls through; the call site should fail to resolve.
        var diags = GetErrorDiagnostics(source);
        Assert.NotEmpty(diags);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static ImmutableArray<Diagnostic> GetErrorDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = compilation.BoundProgram;
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
    }
}
