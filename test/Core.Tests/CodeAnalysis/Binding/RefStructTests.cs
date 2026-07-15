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

    // ADR-0056 (#344) low-hanging-fruit #3: the `[]T -> ReadOnlySpan[T]`
    // user-defined `op_Implicit` that already works at local-init position must
    // also apply when the slice is passed as a call argument, with no GS0154.
    [Fact]
    public void SliceArgument_ToReadOnlySpanParameter_IsPermitted()
    {
        var source = @"
import System
func sum(s ReadOnlySpan[int32]) int32 { return s.Length }
func Main() {
    var nums []int32 = []int32{10, 20, 30}
    Console.WriteLine(sum(nums))
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0154");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    // ADR-0056 (#344): the same implicit conversion applies for `Span[T]`.
    [Fact]
    public void SliceArgument_ToSpanParameter_IsPermitted()
    {
        var source = @"
import System
func len(s Span[int32]) int32 { return s.Length }
func Main() {
    var nums []int32 = []int32{1, 2, 3, 4}
    Console.WriteLine(len(nums))
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0154");
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
class Holder {
    var s ReadOnlySpan[int32]
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
class Holder(s ReadOnlySpan[int32]) {
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

    // Issue #2350: this async function contains no `await` at all, so `s`
    // is never live across a suspension point — replacing the old coarse
    // "any by-ref-like local in any async function" rule
    // (RefStructAsyncLivenessAnalyzer) with sound per-local liveness now
    // permits it. See Issue2350AsyncRefStructLivenessTests for the full
    // suite of safe/unsafe liveness scenarios this fix covers.
    [Fact]
    public void RefStruct_LocalInAsyncFunctionWithNoAwait_IsPermitted()
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
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
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

    [Fact]
    public void UserDeclared_RefStruct_IsRecognizedAsByRefLike()
    {
        var source = @"
package P
ref struct Window {
    var Total int32
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var window = compilation.GlobalScope.Structs.Single(s => s.Name == "Window");
        Assert.True(window.IsRefStruct);
        Assert.True(TypeSymbol.IsByRefLike(window));
    }

    [Fact]
    public void UserDeclared_PlainStruct_IsNotByRefLike()
    {
        var source = @"
package P
struct Plain {
    var Total int32
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var plain = compilation.GlobalScope.Structs.Single(s => s.Name == "Plain");
        Assert.False(plain.IsRefStruct);
        Assert.False(TypeSymbol.IsByRefLike(plain));
    }

    [Fact]
    public void UserDeclared_RefStruct_LocalIsPermitted()
    {
        var source = @"
package P
ref struct Acc {
    var Total int32
}
func use() int32 {
    var a Acc = Acc{Total: 5}
    return a.Total
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_RefStruct_BoxedToObject_Reports_GS0219()
    {
        var source = @"
package P
ref struct Acc {
    var Total int32
}
func box() object {
    var a Acc = Acc{Total: 5}
    var o object = a
    return o
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_RefStruct_StoredInNonRefStructField_Reports_GS0219()
    {
        var source = @"
package P
ref struct Acc {
    var Total int32
}
struct Holder {
    var a Acc
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_RefStruct_FieldInsideRefStruct_IsPermitted()
    {
        var source = @"
package P
ref struct Inner {
    var V int32
}
ref struct Outer {
    var Slot Inner
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_RefStruct_CapturedByClosure_Reports_GS0219()
    {
        var source = @"
package P
ref struct Acc {
    var Total int32
}
func f() {
    var a Acc = Acc{Total: 5}
    var g = func() int32 { return a.Total }
    g()
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_RefStruct_AsGenericTypeArgument_Reports_GS0219()
    {
        var source = @"
package P
import System.Collections.Generic
ref struct Acc {
    var Total int32
}
func f() {
    var l List[Acc]
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStruct_AsTopLevelGlobal_Reports_GS0219()
    {
        // A top-level variable is emitted as a heap-rooted static field, which the
        // CLR forbids for a by-ref-like type. Applies to imported ref structs ...
        var imported = @"
import System
var s ReadOnlySpan[int32] = []int32{1, 2, 3}
";
        Assert.Contains(Bind(imported), d => d.Id == "GS0219");

        // ... and to user-declared ones.
        var user = @"
package P
ref struct Acc {
    var Total int32
}
var a Acc = Acc{Total: 1}
";
        Assert.Contains(Bind(user), d => d.Id == "GS0219");
    }

    // ADR-0056 §1/§2: reading a `ReadOnlySpan[T]` element auto-dereferences the
    // `ref readonly T` indexer return, so `s[i]` observes the pointee `T`
    // (int32), not the managed pointer `Int32&`. The bound shape is a
    // `BoundDereferenceExpression` wrapping a `BoundClrIndexExpression` whose
    // own type is the `ByRefTypeSymbol`.
    [Fact]
    public void SpanElementRead_AutoDereferences_ToPointeeType()
    {
        var source = @"
import System
func get(arr []int32) int32 {
    var s ReadOnlySpan[int32] = arr
    return s[0]
}
";
        var program = BindProgram(source);
        var derefs = CollectIndexReads(program);
        var deref = Assert.Single(derefs);
        Assert.Equal(TypeSymbol.Int32, deref.Type);
        var index = Assert.IsType<GSharp.Core.CodeAnalysis.Binding.BoundClrIndexExpression>(deref.Operand);
        var byRef = Assert.IsType<ByRefTypeSymbol>(index.Type);
        Assert.Equal(TypeSymbol.Int32, byRef.PointeeType);
    }

    // ADR-0056 §2: `total + s[i]` previously failed with GS0129 because the
    // element typed as `System.Int32&`. After auto-deref the read is `int32`,
    // so no operator/type error is reported.
    [Fact]
    public void SpanElementRead_InArithmetic_NoTypeError()
    {
        var source = @"
import System
func sum(arr []int32) int32 {
    var s ReadOnlySpan[int32] = arr
    var total = 0
    var i = 0
    for i < s.Length {
        total = total + s[i]
        i = i + 1
    }
    return total
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0155");
    }

    // ADR-0056 §2: a `Span[T]` element write is permitted (stores through the
    // `ref T` indexer); no GS0226 and no GS0116.
    [Fact]
    public void SpanElementWrite_IsPermitted()
    {
        var source = @"
import System
func set(arr []int32) int32 {
    var s Span[int32] = arr
    s[1] = 99
    return s[1]
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0226");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0116");
    }

    // ADR-0056 §2 / Diagnostics: writing through a `ReadOnlySpan[T]` element is a
    // hard error because its indexer is `ref readonly T`.
    [Fact]
    public void ReadOnlySpanElementWrite_Reports_GS0226()
    {
        var source = @"
import System
func set(arr []int32) {
    var s ReadOnlySpan[int32] = arr
    s[1] = 99
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0226");
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

    private static GSharp.Core.CodeAnalysis.Binding.BoundProgram BindProgram(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
    }

    private static List<GSharp.Core.CodeAnalysis.Binding.BoundDereferenceExpression> CollectIndexReads(
        GSharp.Core.CodeAnalysis.Binding.BoundProgram program)
    {
        var collector = new IndexReadCollector();
        foreach (var body in program.Functions.Values)
        {
            collector.Visit(body);
        }

        collector.Visit(program.Statement);
        return collector.Results;
    }

    // Walks bound function bodies and records every BoundDereferenceExpression
    // whose operand is a BoundClrIndexExpression — i.e. an auto-dereferenced
    // ref-returning indexer read (ADR-0056 §1/§2).
    private sealed class IndexReadCollector : GSharp.Core.CodeAnalysis.Binding.BoundTreeRewriter
    {
        public List<GSharp.Core.CodeAnalysis.Binding.BoundDereferenceExpression> Results { get; } = new();

        public void Visit(GSharp.Core.CodeAnalysis.Binding.BoundStatement statement)
        {
            RewriteStatement(statement);
        }

        protected override GSharp.Core.CodeAnalysis.Binding.BoundExpression RewriteDereferenceExpression(
            GSharp.Core.CodeAnalysis.Binding.BoundDereferenceExpression node)
        {
            if (node.Operand is GSharp.Core.CodeAnalysis.Binding.BoundClrIndexExpression)
            {
                Results.Add(node);
            }

            return base.RewriteDereferenceExpression(node);
        }
    }
}
