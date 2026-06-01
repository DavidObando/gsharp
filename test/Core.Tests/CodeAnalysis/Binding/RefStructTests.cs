// <copyright file="RefStructTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #367: binder + diagnostic coverage for CLR by-ref-like (`ref struct`)
/// types such as <c>System.ReadOnlySpan[T]</c>. A by-ref-like value may be a
/// local, but boxing it, storing it in a field, capturing it in a closure,
/// hoisting it into an async/iterator state machine, or using it as a generic
/// type argument is rejected with GS0219.
/// </summary>
public class RefStructTests
{
    [Fact]
    public void IsByRefLike_RecognizesSpanAndHandler()
    {
        Assert.True(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(ReadOnlySpan<int>))));
        Assert.True(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(Span<int>))));
        Assert.True(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(System.Runtime.CompilerServices.DefaultInterpolatedStringHandler))));
    }

    [Fact]
    public void IsByRefLike_RejectsOrdinaryTypes()
    {
        Assert.False(TypeSymbol.IsByRefLike(TypeSymbol.Int32));
        Assert.False(TypeSymbol.IsByRefLike(TypeSymbol.String));
        Assert.False(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(System.Text.StringBuilder))));
        Assert.False(TypeSymbol.IsByRefLike(null));
    }

    [Fact]
    public void Local_OfRefStruct_IsPermitted()
    {
        var source = @"
import System
func length(arr []int32) int32 {
    var s ReadOnlySpan[int32] = arr
    return s.Length
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void Boxing_RefStruct_ToObject_Reports_GS0219()
    {
        var source = @"
import System
func box(arr []int32) object {
    var s ReadOnlySpan[int32] = arr
    var o object = s
    return o
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStruct_InstanceField_Reports_GS0219()
    {
        var source = @"
import System
type Holder class {
    s ReadOnlySpan[int32]
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStruct_PrimaryConstructorField_Reports_GS0219()
    {
        var source = @"
import System
type Holder class(s ReadOnlySpan[int32]) {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStruct_CapturedByClosure_Reports_GS0219()
    {
        var source = @"
import System
func f(arr []int32) {
    var s ReadOnlySpan[int32] = arr
    var g = func() int32 { return s.Length }
    g()
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStruct_LocalInAsyncFunction_Reports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks
async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    return s.Length
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStruct_LocalInIterator_Reports_GS0219()
    {
        var source = @"
import System
import System.Collections.Generic
func gen(arr []int32) sequence[int32] {
    var s ReadOnlySpan[int32] = arr
    yield s.Length
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStruct_AsGenericTypeArgument_Reports_GS0219()
    {
        var source = @"
import System
import System.Collections.Generic
func f() {
    var l List[ReadOnlySpan[int32]]
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    // Binds declarations and function bodies and returns the resulting
    // diagnostics without evaluating. Used for constructs (e.g. iterators) that
    // the interpreter cannot execute but whose binder diagnostics still apply.
    private static System.Collections.Immutable.ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
