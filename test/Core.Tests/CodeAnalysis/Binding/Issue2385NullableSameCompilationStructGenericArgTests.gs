// <copyright file="Issue2385NullableSameCompilationStructGenericArgTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2385: (cref:ConversionClassifier.TrySubstituteParameterTypeFromReceiver)
/// recovers the substituted parameter type for a call on an imported generic
/// receiver (e.g. `List[T].Add(value)`) whose type argument is a
/// same-compilation user type, so the binder does not misclassify the
/// argument as a boxing conversion to the erased CLR shape. Its gate,
/// however, only matched a receiver type argument that was DIRECTLY a
/// (cref:StructSymbol)/(cref:InterfaceSymbol)/(cref:EnumSymbol)/
/// (cref:DelegateTypeSymbol) (or a nested (cref:ImportedTypeSymbol)) —
/// a same-compilation struct/enum WRAPPED in (cref:NullableTypeSymbol)
/// (e.g. the receiver type argument of `List[Point?]`) matched none of
/// those cases, so the gate bailed out (returned `null`)
/// before ever attempting the substitution. The call then fell back to the
/// erased CLR parameter type (effectively `object`), and the argument
/// was bound as a boxing conversion — emitting an invalid `box`/`ldnull`
/// sequence against what is actually a value-type `Nullable<T>`
/// generic parameter slot (`InvalidProgramException` at runtime).
///
/// The fix replaces the narrow ad hoc list with
/// (cref:TypeSymbol.ContainsSameCompilationUserType) — the general,
/// already-established predicate for exactly this shape (it recurses through
/// `NullableTypeSymbol`/`SliceTypeSymbol`/`ArrayTypeSymbol`/
/// `TupleTypeSymbol`/nested `ImportedTypeSymbol` uniformly), which
/// is a structural superset of the old list and additionally generalizes to
/// same-compilation enums wrapped in `Nullable<T>`.
///
/// These tests assert directly on the bound
/// (cref:BoundImportedInstanceCallExpression.Arguments) types (after
/// argument-conversion rebinding) rather than only on the absence of
/// diagnostics, since the pre-fix defect compiled without any diagnostic and
/// only manifested as an `InvalidProgramException` at runtime.
open class Issue2385NullableSameCompilationStructGenericArgTests {
    @Fact
    func ListOfNullableUserStruct_AddConcreteValue_ArgumentSubstitutedToNullableOfStruct() {
        const source = `
package p
import System.Collections.Generic
struct Point2385(X int32, Y int32) { }
func Outer() {
    let list = List[Point2385?]()
    list.Add(Point2385(1, 2))
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundImportedInstanceCallExpression? = FindImportedInstanceCall(compilation, "Outer", "Add")
        Assert.NotNull(call)
        let argType = Assert.IsType[NullableTypeSymbol](call!!.Arguments[0].Type)
        Assert.Equal("Point2385", argType.UnderlyingType.Name)
        Assert.NotEqual(typeof(object), argType.UnderlyingType.ClrType)
    }

    @Fact
    func ListOfNullableUserStruct_AddNil_ArgumentSubstitutedToNullableOfStruct_NotErasedToObject() {
        const source = `
package p
import System.Collections.Generic
struct Point2385Nil(X int32, Y int32) { }
func Outer() {
    let list = List[Point2385Nil?]()
    list.Add(nil)
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundImportedInstanceCallExpression? = FindImportedInstanceCall(compilation, "Outer", "Add")
        Assert.NotNull(call)
        // The nil argument must be lowered (by the binder) at the recovered
        // Nullable[Point2385Nil] target, not left/erased at `object` — a
        // `BoundDefaultExpression` typed `object` is exactly the pre-fix
        // shape that emitted the invalid `ldnull` against a value-type slot.
        let argType = Assert.IsType[NullableTypeSymbol](call!!.Arguments[0].Type)
        Assert.Equal("Point2385Nil", argType.UnderlyingType.Name)
        Assert.IsType[BoundDefaultExpression](call!!.Arguments[0])
    }

    @Fact
    func ListOfNullableUserEnum_AddConcreteValueAndNil_ArgumentsSubstitutedToNullableOfEnum() {
        const source = `
package p
import System.Collections.Generic
enum Color2385 { Red, Green, Blue }
func Outer() {
    let list = List[Color2385?]()
    list.Add(Color2385.Green)
    list.Add(nil)
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let calls = FindImportedInstanceCalls(compilation, "Outer", "Add")
        Assert.Equal(2, calls.Count)
        for call in calls {
            let argType = Assert.IsType[NullableTypeSymbol](call.Arguments[0].Type)
            Assert.Equal("Color2385", argType.UnderlyingType.Name)
        }
    }

    @Fact
    func DictionaryValueNullableUserStruct_IndexerSet_ArgumentSubstitutedToNullableOfStruct() {
        // Coverage: the same-compilation nullable struct occupies the SECOND
        // (value) type-argument position of a two-argument imported generic
        // (Dictionary[TKey,TValue]), via a plain indexer assignment
        // (`d[k] = v`, bound as BoundClrIndexAssignmentExpression). This
        // path uses the separate `MapErasedIndexerElementType` substitution
        // helper (issue #968), whose gate (`arg.ClrType == null`) already
        // covers a NullableTypeSymbol wrapping a same-compilation struct
        // (NullableTypeSymbol.ClrType delegates to the underlying type,
        // which is null pre-emit) — so this scenario was NOT part of the
        // #2385 defect. Kept as a sibling-path regression control alongside
        // the (buggy, now-fixed) Add(...) call-argument path.
        const source = `
package p
import System.Collections.Generic
struct Point2385Dict(X int32, Y int32) { }
func Outer() {
    let dict = Dictionary[string, Point2385Dict?]()
    dict["a"] = Point2385Dict(1, 2)
    dict["b"] = nil
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        // A plain (non-compound) indexer assignment `d[k] = v` binds to
        // BoundClrIndexAssignmentExpression, not a named `set_Item` call
        // node — the emitter later resolves the setter from `Indexer`.
        let writes = FindIndexAssignments(compilation, "Outer")
        Assert.Equal(2, writes.Count)
        for write in writes {
            let argType = Assert.IsType[NullableTypeSymbol](write.Value.Type)
            Assert.Equal("Point2385Dict", argType.UnderlyingType.Name)
        }
    }

    @Fact
    func ListOfNonNullableUserStruct_AddConcreteValue_RegressionStillSubstitutesDirectly() {
        // Regression control: the pre-existing (#765) DIRECT (non-nullable)
        // same-compilation struct type argument must still substitute
        // correctly — the fix only widens the gate, it must not narrow it.
        const source = `
package p
import System.Collections.Generic
struct Point2385Direct(X int32, Y int32) { }
func Outer() {
    let list = List[Point2385Direct]()
    list.Add(Point2385Direct(1, 2))
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundImportedInstanceCallExpression? = FindImportedInstanceCall(compilation, "Outer", "Add")
        Assert.NotNull(call)
        // Identity conversion (no Nullable wrapper) — argument type is the
        // struct itself, not erased to object.
        let argType = Assert.IsType[StructSymbol](call!!.Arguments[0].Type)
        Assert.Equal("Point2385Direct", argType.Name)
    }

    @Fact
    func ListOfNullablePrimitive_AddConcreteValueAndNil_RegressionUnaffected() {
        // Negative control: a BUILT-IN nullable value type (Nullable<int32>)
        // must keep binding and running exactly as before — this scenario
        // never reaches TrySubstituteParameterTypeFromReceiver's
        // same-compilation gate at all (overload resolution here actually
        // prefers the explicit `IList.Add(object)` interface implementation
        // over the generic `List<T>.Add(T)` for a bare int32 literal, and
        // that boxing conversion is unrelated to, and unaffected by, the
        // #2385 fix). The full compile+run+ILVerify coverage for this
        // control lives in the Compiler.Tests emit-level counterpart.
        const source = `
package p
import System.Collections.Generic
func Outer() {
    let list = List[int32?]()
    list.Add(42)
    list.Add(nil)
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let calls = FindImportedInstanceCalls(compilation, "Outer", "Add")
        Assert.Equal(2, calls.Count)
    }

    @Fact
    func ListOfTupleWithNullableReference_AddNil_RebuildsTargetTuple() {
        const source = `package p
import System.Collections.Generic
func Outer() {
    let list = List[(string, string?)]()
    list.Add(("x", nil))
}`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundImportedInstanceCallExpression? = FindImportedInstanceCall(compilation, "Outer", "Add")
        Assert.NotNull(call)
        Assert.True(call!!.Method.DeclaringType?.IsGenericType, call!!.Method.ToString())
        Assert.Equal(typeof(List[_]).FullName, call!!.Method.DeclaringType?.GetGenericTypeDefinition().FullName)
        let tuple = Assert.IsType[TupleTypeSymbol](call!!.Arguments[0].Type)
        Assert.IsType[NullableTypeSymbol](tuple.ElementTypes[1])
        let literal = Assert.IsType[BoundTupleLiteralExpression](call!!.Arguments[0])
        Assert.Equal(tuple.ElementTypes[1], literal.Elements[1].Type)
    }

    private class ImportedInstanceCallCollector : BoundTreeWalker {
        private let methodName string

        init(methodName string) {
            Collected = List[BoundImportedInstanceCallExpression]()
            this.methodName = methodName
        }

        prop Collected List[BoundImportedInstanceCallExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundImportedInstanceCallExpression call && call.Method.Name == methodName {
                Collected.Add(call)
            }
            base.VisitExpression(node)
        }
    }

    private class ClrIndexAssignmentCollector : BoundTreeWalker {
        init() {
            Collected = List[BoundClrIndexAssignmentExpression]()
        }

        prop Collected List[BoundClrIndexAssignmentExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundClrIndexAssignmentExpression write {
                Collected.Add(write)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindImportedInstanceCall(
            compilation Compilation,
            functionName string,
            methodName string
        ) BoundImportedInstanceCallExpression? -> FindImportedInstanceCalls(
            compilation,
            functionName,
            methodName
        ).FirstOrDefault()

        private func FindImportedInstanceCalls(compilation Compilation, functionName string, methodName string) List[
            BoundImportedInstanceCallExpression
        ] {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = ImportedInstanceCallCollector(methodName)
            collector.Visit(body)
            return collector.Collected
        }

        private func FindIndexAssignments(compilation Compilation, functionName string) List[
            BoundClrIndexAssignmentExpression
        ] {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = ClrIndexAssignmentCollector()
            collector.Visit(body)
            return collector.Collected
        }
    }
}
