// <copyright file="Issue2381AsyncGenericCollectionTaskWrapTests.cs" company="GSharp">
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

/// Issue #2381: (cref:LambdaBinder.WrapAsTask) previously only routed
/// a NULL-(cref:TypeSymbol.ClrType) element (bare same-compilation
/// struct/interface/enum/tuple, or a type-parameter-containing type — issues
/// #1785/#2026/#2232) through the symbolic `Task<T>` construction
/// that preserves the real element identity for downstream (emit-time and
/// call-site delegate-target-typing) consumers. An imported generic
/// collection closed over a same-compilation argument (e.g.
/// `List[UserClass]`) reports a NON-null but object-erased ClrType
/// (`List<object>`) and a same-compilation array/slice element
/// (e.g. `[]UserClass`) reports a genuinely null ClrType that matched
/// none of the old hand-listed wrapper kinds — both silently fell through to
/// either the ordinary erased-reflection `Task<T>` construction or
/// (for the array/slice case) no Task-wrapping at all.
///
/// Mirroring `Issue2026GenericAsyncTaskWrapTests`'s pattern: a same-
/// compilation (cref:FunctionSymbol.Type) holds the DECLARED
/// (unwrapped) inner result type — `WrapAsTask`'s widened, Task-wrapped
/// "observable" type is instead computed at each call site (a
/// (cref:BoundCallExpression) invoking the async function). These
/// tests therefore bind a small caller around each async repro and assert on
/// the CALL EXPRESSION's `.Type`, exactly like the #2026 suite.
open class Issue2381AsyncGenericCollectionTaskWrapTests {
    @Fact
    func AsyncFunctionReturningListOfUserClass_CallSiteObservedAsSymbolicTaskOfListOfUserClass() {
        const source = `
package p
import System.Collections.Generic
class DiagnosticCheck2381Wrap {}
async func RunAsync() List[DiagnosticCheck2381Wrap] {
    let results = List[DiagnosticCheck2381Wrap]()
    return results
}
func Outer() {
    var r = RunAsync()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "RunAsync")
        AssertIsTaskOfCollectionOfUserType(call!!.Type, "List", "DiagnosticCheck2381Wrap")
    }

    @Fact
    func AsyncFunctionReturningDictionaryOfStringToUserClass_CallSiteObservedAsSymbolicTaskOfDictionary() {
        const source = `
package p
import System.Collections.Generic
class DiagnosticCheck2381Dict {}
async func RunAsync() Dictionary[string, DiagnosticCheck2381Dict] {
    let results = Dictionary[string, DiagnosticCheck2381Dict]()
    return results
}
func Outer() {
    var r = RunAsync()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "RunAsync")
        let task = Assert.IsType[ImportedTypeSymbol](call!!.Type)
        Assert.True(
            task.ClrType!!.IsGenericType && task.ClrType!!.GetGenericTypeDefinition() == typeof(
                System.Threading.Tasks.Task[_]
            )
        )
        Assert.Single(task.TypeArguments)
        let dict = Assert.IsType[ImportedTypeSymbol](task.TypeArguments[0])
        Assert.Equal(2, dict.TypeArguments.Length)
        Assert.Equal("string", dict.TypeArguments[0].Name)
        Assert.Equal("DiagnosticCheck2381Dict", dict.TypeArguments[1].Name)
        Assert.NotEqual(typeof(object), dict.TypeArguments[1].ClrType)
    }

    @Fact
    func AsyncFunctionReturningNestedListOfListOfUserClass_CallSiteObservedAsSymbolicTaskThroughBothLayers() {
        const source = `
package p
import System.Collections.Generic
class DiagnosticCheck2381Nested {}
async func RunAsync() List[List[DiagnosticCheck2381Nested]] {
    let results = List[List[DiagnosticCheck2381Nested]]()
    return results
}
func Outer() {
    var r = RunAsync()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "RunAsync")
        let task = Assert.IsType[ImportedTypeSymbol](call!!.Type)
        let outerList = Assert.IsType[ImportedTypeSymbol](task.TypeArguments[0])
        let innerList = Assert.IsType[ImportedTypeSymbol](outerList.TypeArguments[0])
        Assert.Equal("DiagnosticCheck2381Nested", innerList.TypeArguments[0].Name)
    }

    @Fact
    func AsyncFunctionReturningArrayOfUserClass_CallSiteObservedAsSymbolicTaskOfArray() {
        // Coverage: array/slice element — a distinct null-ClrType shape from
        // the imported-generic (List/Dictionary) case above, since
        // SliceTypeSymbol/ArrayTypeSymbol compute their ClrType once, at
        // construction, as `elementType.ClrType?.MakeArrayType()`.
        const source = `
package p
class DiagnosticCheck2381Arr {}
async func RunAsync() []DiagnosticCheck2381Arr {
    let results = []DiagnosticCheck2381Arr{}
    return results
}
func Outer() {
    var r = RunAsync()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "RunAsync")
        let task = Assert.IsType[ImportedTypeSymbol](call!!.Type)
        Assert.True(
            task.ClrType!!.IsGenericType && task.ClrType!!.GetGenericTypeDefinition() == typeof(
                System.Threading.Tasks.Task[_]
            )
        )
        Assert.Single(task.TypeArguments)
        let arr = Assert.IsType[SliceTypeSymbol](task.TypeArguments[0])
        Assert.Equal("DiagnosticCheck2381Arr", arr.ElementType.Name)
    }

    @Fact
    func AsyncFunctionReturningListOfValueTypeStruct_CallSiteObservedAsSymbolicTaskOfListOfStruct() {
        // Coverage: same-compilation VALUE type (struct) element, not class.
        const source = `
package p
import System.Collections.Generic
struct Point2381Wrap(X int32) { }
async func RunAsync() List[Point2381Wrap] {
    let results = List[Point2381Wrap]()
    return results
}
func Outer() {
    var r = RunAsync()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "RunAsync")
        AssertIsTaskOfCollectionOfUserType(call!!.Type, "List", "Point2381Wrap")
    }

    @Fact
    func AsyncFunctionReturningListOfPrimitive_CallSiteRegressionUsesOrdinaryReflectionTask() {
        // Negative control: a collection over a BUILT-IN element type must
        // keep the ordinary (non-symbolic) reflection-based Task<T>
        // construction — the real, already-closed CLR Task<List<int32>>,
        // not a GetConstructed symbolic wrapper — matching pre-#2381
        // behavior exactly.
        const source = `
package p
import System.Collections.Generic
async func RunAsync() List[int32] {
    let results = List[int32]()
    return results
}
func Outer() {
    var r = RunAsync()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "RunAsync")
        let task = Assert.IsType[ImportedTypeSymbol](call!!.Type)
        Assert.True(
            task.ClrType!!.IsGenericType && task.ClrType!!.GetGenericTypeDefinition() == typeof(
                System.Threading.Tasks.Task[_]
            )
        )
        let listClrType = task.ClrType!!.GetGenericArguments()[0]
        Assert.True(
            listClrType.IsGenericType && listClrType.GetGenericTypeDefinition() == typeof(
                System.Collections.Generic.List[_]
            )
        )
        Assert.Equal(typeof(int32), listClrType.GetGenericArguments()[0])
    }

    @Fact
    func AsyncFunctionReturningNonGenericUserClass_CallSiteRegressionStillWrapsSymbolically() {
        // Regression: the pre-existing #1785/#2026 bare same-compilation
        // class/struct shape (no surrounding collection) must still route
        // through the symbolic Task<T> construction exactly as before.
        const source = `
package p
class DiagnosticCheck2381Bare {}
async func RunAsync() DiagnosticCheck2381Bare {
    return DiagnosticCheck2381Bare()
}
func Outer() {
    var r = RunAsync()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "RunAsync")
        let task = Assert.IsType[ImportedTypeSymbol](call!!.Type)
        Assert.Single(task.TypeArguments)
        Assert.Equal("DiagnosticCheck2381Bare", task.TypeArguments[0].Name)
    }

    private class CallCollector : BoundTreeWalker {
        private let callName string

        init(callName string) {
            Collected = List[BoundCallExpression]()
            this.callName = callName
        }

        prop Collected List[BoundCallExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundCallExpression call && call.Function.Name == callName {
                Collected.Add(call)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func AssertIsTaskOfCollectionOfUserType(
            type TypeSymbol,
            collectionOpenName string,
            expectedElementName string
        ) {
            let task = Assert.IsType[ImportedTypeSymbol](type)
            Assert.True(
                task.ClrType!!.IsGenericType && task.ClrType!!.GetGenericTypeDefinition() == typeof(
                    System.Threading.Tasks.Task[_]
                )
            )
            Assert.Single(task.TypeArguments)
            let collection = Assert.IsType[ImportedTypeSymbol](task.TypeArguments[0])
            Assert.Equal(collectionOpenName, collection.OpenDefinition!!.Name.Split('`')[0])
            Assert.Single(collection.TypeArguments)
            Assert.Equal(expectedElementName, collection.TypeArguments[0].Name)
            Assert.NotEqual(typeof(object), collection.TypeArguments[0].ClrType)
        }

        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindCall(compilation Compilation, functionName string, callName string) BoundCallExpression? {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = Issue2381AsyncGenericCollectionTaskWrapTests.CallCollector(callName)
            collector.Visit(body)
            return collector.Collected.FirstOrDefault()
        }
    }
}
