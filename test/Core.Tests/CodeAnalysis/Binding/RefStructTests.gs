// <copyright file="RefStructTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis.Binding
import System.Runtime.CompilerServices
import System.Text

/// Issue #367: binder + diagnostic coverage for CLR by-ref-like (`ref struct`)
/// types such as `System.ReadOnlySpan[T]`. A by-ref-like value may be a
/// local, but boxing it, storing it in a field, capturing it in a closure,
/// hoisting it into an async/iterator state machine, or using it as a generic
/// type argument is rejected with GS0219.
open class RefStructTests {
    @Fact
    func IsByRefLike_RecognizesSpanAndHandler() {
        Assert.True(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(ReadOnlySpan[int32]))))
        Assert.True(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(Span[int32]))))
        Assert.True(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(DefaultInterpolatedStringHandler))))
    }

    @Fact
    func IsByRefLike_RejectsOrdinaryTypes() {
        Assert.False(TypeSymbol.IsByRefLike(TypeSymbol.Int32))
        Assert.False(TypeSymbol.IsByRefLike(TypeSymbol.String))
        Assert.False(TypeSymbol.IsByRefLike(TypeSymbol.FromClrType(typeof(StringBuilder))))
        Assert.False(TypeSymbol.IsByRefLike(nil))
    }

    @Fact
    func Local_OfRefStruct_IsPermitted() {
        let source = `
import System
func length(arr []int32) int32 {
    var s ReadOnlySpan[int32] = arr
    return s.Length
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // ADR-0056 (#344) low-hanging-fruit #3: the `[]T -> ReadOnlySpan[T]`
    // user-defined `op_Implicit` that already works at local-init position must
    // also apply when the slice is passed as a call argument, with no GS0154.
    @Fact
    func SliceArgument_ToReadOnlySpanParameter_IsPermitted() {
        let source = `
import System
func sum(s ReadOnlySpan[int32]) int32 { return s.Length }
func Main() {
    var nums []int32 = []int32{10, 20, 30}
    Console.WriteLine(sum(nums))
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // ADR-0056 (#344): the same implicit conversion applies for `Span[T]`.
    @Fact
    func SliceArgument_ToSpanParameter_IsPermitted() {
        let source = `
import System
func s Span[int32].Length int32 { return s.Length }
func Main() {
    var nums []int32 = []int32{1, 2, 3, 4}
    Console.WriteLine(nums.Length)
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func Boxing_RefStruct_ToObject_Reports_GS0219() {
        let source = `
import System
func box(arr []int32) object {
    var s ReadOnlySpan[int32] = arr
    var o object = s
    return o
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func RefStruct_InstanceField_Reports_GS0219() {
        let source = `
import System
class Holder {
    var s ReadOnlySpan[int32]
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func RefStruct_PrimaryConstructorField_Reports_GS0219() {
        let source = `
import System
class Holder(s ReadOnlySpan[int32]) {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func RefStruct_CapturedByClosure_Reports_GS0219() {
        let source = `
import System
func f(arr []int32) {
    var s ReadOnlySpan[int32] = arr
    var g = func() int32 { return s.Length }
    g()
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // Issue #2350: this async function contains no `await` at all, so `s`
    // is never live across a suspension point — replacing the old coarse
    // "any by-ref-like local in any async function" rule
    // (RefStructAsyncLivenessAnalyzer) with sound per-local liveness now
    // permits it. See Issue2350AsyncRefStructLivenessTests for the full
    // suite of safe/unsafe liveness scenarios this fix covers.
    @Fact
    func RefStruct_LocalInAsyncFunctionWithNoAwait_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks
async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    return s.Length
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func RefStruct_LocalInIterator_Reports_GS0219() {
        let source = `
import System
import System.Collections.Generic
func gen(arr []int32) sequence[int32] {
    var s ReadOnlySpan[int32] = arr
    yield s.Length
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func RefStruct_AsGenericTypeArgument_Reports_GS0219() {
        let source = `
import System
import System.Collections.Generic
func f() {
    var l List[ReadOnlySpan[int32]]
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_RefStruct_IsRecognizedAsByRefLike() {
        let source = `
package P
ref struct Window {
    var Total int32
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let window = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Window")
        Assert.True(window.IsRefStruct)
        Assert.True(TypeSymbol.IsByRefLike(window))
    }

    @Fact
    func UserDeclared_PlainStruct_IsNotByRefLike() {
        let source = `
package P
struct Plain {
    var Total int32
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let plain = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Plain")
        Assert.False(plain.IsRefStruct)
        Assert.False(TypeSymbol.IsByRefLike(plain))
    }

    @Fact
    func UserDeclared_RefStruct_LocalIsPermitted() {
        let source = `
package P
ref struct Acc {
    var Total int32
}
func use() int32 {
    var a Acc = Acc{Total: 5}
    return a.Total
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_RefStruct_BoxedToObject_Reports_GS0219() {
        let source = `
package P
ref struct Acc {
    var Total int32
}
func box() object {
    var a Acc = Acc{Total: 5}
    var o object = a
    return o
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_RefStruct_StoredInNonRefStructField_Reports_GS0219() {
        let source = `
package P
ref struct Acc {
    var Total int32
}
struct Holder {
    var a Acc
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_RefStruct_FieldInsideRefStruct_IsPermitted() {
        let source = `
package P
ref struct Inner {
    var V int32
}
ref struct Outer {
    var Slot Inner
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_RefStruct_CapturedByClosure_Reports_GS0219() {
        let source = `
package P
ref struct Acc {
    var Total int32
}
func f() {
    var a Acc = Acc{Total: 5}
    var g = func() int32 { return a.Total }
    g()
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_RefStruct_AsGenericTypeArgument_Reports_GS0219() {
        let source = `
package P
import System.Collections.Generic
ref struct Acc {
    var Total int32
}
func f() {
    var l List[Acc]
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func RefStruct_AsTopLevelGlobal_Reports_GS0219() {
        // A top-level variable is emitted as a heap-rooted static field, which the
        // CLR forbids for a by-ref-like type. Applies to imported ref structs ...
        let imported = `
import System
var s ReadOnlySpan[int32] = []int32{1, 2, 3}
`
        Assert.Contains(Bind(imported), (d Diagnostic) -> d.Id == "GS0219")
        // ... and to user-declared ones.
        let user = `
package P
ref struct Acc {
    var Total int32
}
var a Acc = Acc{Total: 1}
`
        Assert.Contains(Bind(user), (d Diagnostic) -> d.Id == "GS0219")
    }

    // ADR-0056 §1/§2: reading a `ReadOnlySpan[T]` element auto-dereferences the
    // `ref readonly T` indexer return, so `s[i]` observes the pointee `T`
    // (int32), not the managed pointer `Int32&`. The bound shape is a
    // `BoundDereferenceExpression` wrapping a `BoundClrIndexExpression` whose
    // own type is the `ByRefTypeSymbol`.
    @Fact
    func SpanElementRead_AutoDereferences_ToPointeeType() {
        let source = `
import System
func get(arr []int32) int32 {
    var s ReadOnlySpan[int32] = arr
    return s[0]
}
`
        let program = BindProgram(source)
        let derefs = CollectIndexReads(program)
        let deref = Assert.Single(derefs)
        Assert.Equal(TypeSymbol.Int32, deref.Type)
        let index = Assert.IsType[BoundClrIndexExpression](deref.Operand)
        let byRef = Assert.IsType[ByRefTypeSymbol](index.Type)
        Assert.Equal(TypeSymbol.Int32, byRef.PointeeType)
    }

    // ADR-0056 §2: `total + s[i]` previously failed with GS0129 because the
    // element typed as `System.Int32&`. After auto-deref the read is `int32`,
    // so no operator/type error is reported.
    @Fact
    func SpanElementRead_InArithmetic_NoTypeError() {
        let source = `
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
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    // ADR-0056 §2: a `Span[T]` element write is permitted (stores through the
    // `ref T` indexer); no GS0226 and no GS0116.
    @Fact
    func SpanElementWrite_IsPermitted() {
        let source = `
import System
func set(arr []int32) int32 {
    var s Span[int32] = arr
    s[1] = 99
    return s[1]
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0226")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0116")
    }

    // ADR-0056 §2 / Diagnostics: writing through a `ReadOnlySpan[T]` element is a
    // hard error because its indexer is `ref readonly T`.
    @Fact
    func ReadOnlySpanElementWrite_Reports_GS0226() {
        let source = `
import System
func set(arr []int32) {
    var s ReadOnlySpan[int32] = arr
    s[1] = 99
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0226")
    }

    // Issue #5216: `Dictionary.GetAlternateLookup[TAlternateKey]` declares `allows ref struct`
    // (the CLR AllowByRefLike flag), so a by-ref-like type argument binds without a diagnostic.
    @Fact
    func AllowsRefStruct_ImportedMethod_AcceptsByRefLikeTypeArgument() {
        let source = `
import System
import System.Collections.Generic
func probe() int32 {
    let d = Dictionary[string, int32]()
    let lookup = d.GetAlternateLookup[ReadOnlySpan[char]]()
    return lookup["a".AsSpan()]
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    // Issue #5216: the constructed nested type `AlternateLookup[ReadOnlySpan[char]]` names the
    // same `allows ref struct` parameter in a type position.
    @Fact
    func AllowsRefStruct_ImportedNestedType_AcceptsByRefLikeTypeArgument() {
        let source = `
import System
import System.Collections.Generic
func probe(d Dictionary[string, int32]) int32 {
    var lookup Dictionary[string, int32].AlternateLookup[ReadOnlySpan[char]] = d.GetAlternateLookup[ReadOnlySpan[char]]()
    return lookup["a".AsSpan()]
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    // Issue #5216: a parameter without the flag still rejects the argument. `List[T]` reports
    // GS0219 in a type position and GS0152 on a constructor call, and `Array.Empty[T]` finds no
    // applicable function (GS0159).
    @Fact
    func NoAllowsRefStruct_ImportedGenericType_RejectsByRefLikeTypeArgument() {
        let source = `
import System
import System.Collections.Generic
func f() {
    var l List[ReadOnlySpan[int32]]
    let m = List[ReadOnlySpan[int32]]()
}
`
        let diagnostics = Bind(source)
        let errors = diagnostics.Where((d Diagnostic) -> d.IsError).Select((d Diagnostic) -> d.Id).ToArray()
        Assert.Equal([]string{"GS0219", "GS0152"}, errors)
    }

    @Fact
    func NoAllowsRefStruct_ImportedGenericMethod_RejectsByRefLikeTypeArgument() {
        let source = `
import System
func f() {
    let a = Array.Empty[ReadOnlySpan[char]]()
}
`
        let diagnostics = Bind(source)
        let errors = diagnostics.Where((d Diagnostic) -> d.IsError).Select((d Diagnostic) -> d.Id).ToArray()
        Assert.Equal([]string{"GS0159"}, errors)
    }

    // Walks bound function bodies and records every BoundDereferenceExpression
    // whose operand is a BoundClrIndexExpression — i.e. an auto-dereferenced
    // ref-returning indexer read (ADR-0056 §1/§2).
    private class IndexReadCollector : BoundTreeRewriter {
        init() {
            Results = List[BoundDereferenceExpression]()
        }

        prop Results List[BoundDereferenceExpression] {
            get;
        }

        func Visit(statement BoundStatement?) {
            RewriteStatement(statement!!)
        }

        protected override func RewriteDereferenceExpression(node BoundDereferenceExpression) BoundExpression {
            if node.Operand is BoundClrIndexExpression {
                Results.Add(node)
            }
            return base.RewriteDereferenceExpression(node)
        }
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        // Binds declarations and function bodies without executing them. Used when
        // binder diagnostics, rather than runtime behavior, are the test subject.
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .ToImmutableArray()
        }

        private func BindProgram(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return Binder.BindProgram(compilation.GlobalScope, compilation.References)
        }

        private func CollectIndexReads(program BoundProgram) List[BoundDereferenceExpression] {
            let collector = IndexReadCollector()
            for body in program.Functions.Values {
                collector.Visit(body)
            }
            collector.Visit(program.Statement)
            return collector.Results
        }
    }
}
