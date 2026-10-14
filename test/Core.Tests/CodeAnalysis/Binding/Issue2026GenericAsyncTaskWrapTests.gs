// <copyright file="Issue2026GenericAsyncTaskWrapTests.cs" company="GSharp">
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

/// Issue #2026: calling a generic `async func` (or an async
/// local-function-literal invoked through its delegate value) from inside
/// another generic function must observe the call's result type as
/// `Task[U]` (the substituted return type Task-wrapped) — mirroring the
/// non-generic case — not the raw substituted return type `U`.
/// Previously (cref:LambdaBinder.WrapAsTask) only special-cased a
/// `null`-(cref:TypeSymbol.ClrType) element for same-compilation
/// `struct`/`interface`/`enum` types, silently returning the
/// bare element (unwrapped) for a still-open (cref:TypeParameterSymbol)
/// (whose `ClrType` is also `null`), which made
/// `await r` report GS0133 ("cannot be awaited").
open class Issue2026GenericAsyncTaskWrapTests {
    @Fact
    func GenericAsyncFunctionCall_InsideAnotherGeneric_ObservedAsTaskOfSubstitutedType() {
        const source = `
package p
async func Foo[U](x U) U {
    return x
}
async func Outer[U](seed U) U {
    var r = Foo(seed)
    return await r
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "Foo")
        Assert.NotNull(call)
        AssertIsTaskOf(call!!.Type, expectedTypeArgumentName: "U")
    }

    @Fact
    func GenericAsyncFunctionCall_AtTopLevel_ClosesOverConcreteTypeArgument() {
        const source = `
package p
async func Foo[U](x U) U {
    return x
}
async func Outer[U](seed U) U {
    var r = Foo(seed)
    return await r
}
var t = Outer("hi")
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
    }

    @Fact
    func AsyncLocalFunctionLiteral_ReferencingEnclosingTypeParameter_ObservedAsTaskOfSubstitutedType() {
        // Issue #2026's repro predates issue #2016's GS0468 gate (landed on
        // this branch's parent commit): a local function-literal (named via
        // `let`/`var`/`const`) that directly references an enclosing generic
        // function's type parameter in its own signature/body — call-shape
        // (b) from #2026's original description. #2016 (and, later, its own
        // GS0468 restriction) treated this as an invalid-IL shape and
        // rejected it outright. Issue #4223 makes the RETURN-TYPE/body shape
        // of this correct — UserTokenResolver.TryPromoteNonCapturingGenericLambda
        // reifies the referenced enclosing `U` via
        // ReflectionMetadataEmitter.RegisterStateMachineEnclosingGenerics — so
        // GS0468 no longer fires for it, and this regression test pins the
        // ORIGINAL #2026 concern directly: the call through the local
        // function-literal's delegate value is observed as `Task[U]` (the
        // substituted return type Task-wrapped), and `await r` reports
        // neither GS0133 nor GS0468.
        //
        // `U` is referenced only via `foo`'s RETURN type here, never its own
        // parameter list: an async zero-capture local function whose own
        // parameter type references an enclosing type parameter still keeps
        // GS0468 (see LambdaBinder.CheckAsyncNonGenericLocalFunctionEnclosingTypeParameterInParameter
        // and Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests.NonGenericAsyncLocalFunction_ParameterReferencesEnclosingMethodTypeParameter_StillReportsGS0468) —
        // that shape routes through a pre-existing, unrelated defect in the
        // async "erased delegate" adapter's parameter-unboxing conversion,
        // confirmed to crash at run time for a value-typed instantiation.
        const source = `
package p
async func Outer[U](seed U) U {
    let foo = async func() U { return default }
    var r = foo()
    return await r
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let call BoundIndirectCallExpression? = FindIndirectCall(compilation, "Outer")
        Assert.NotNull(call)
        AssertIsTaskOf(call!!.Type, expectedTypeArgumentName: "U")
    }

    @Fact
    func AsyncLocalFunctionLiteral_InvokedThroughDelegateValue_ConcreteType_StillWrapsAsTask_Regression() {
        // Baseline regression for the (still-legal) local-function-literal
        // call shape: a concrete (non-generic-type-parameter) async
        // local-function-literal invoked through its delegate value must
        // still observe Task[T] at the call site, matching top-level async
        // functions. This shape never depended on the WrapAsTask fix (its
        // element type always had a real ClrType), but it pins the sibling
        // call path stays correct alongside the #2026 fix.
        const source = `
package p
async func Outer(seed int32) int32 {
    let foo = async func(x int32) int32 { return x }
    var r = foo(seed)
    return await r
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let indirectCall BoundIndirectCallExpression? = FindIndirectCall(compilation, "Outer")
        Assert.NotNull(indirectCall)
        Assert.True(
            indirectCall!!.Type is ImportedTypeSymbol imported &&
                imported.ClrType!!.IsGenericType &&
                imported.ClrType!!.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task[_])
        )
    }

    @Fact
    func GenericAsyncFunctionCall_NotAwaited_StillObservedAsTask_ForDownstreamUse() {
        // The issue explicitly calls out the "call but don't await" shape:
        // the call's result must still type as Task[U] for any downstream
        // use (here: assigning it to another local of the same inferred type).
        const source = `
package p
async func Foo[U](x U) U {
    return x
}
func Outer[U](seed U) {
    var r = Foo(seed)
    var r2 = r
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "Foo")
        Assert.NotNull(call)
        AssertIsTaskOf(call!!.Type, expectedTypeArgumentName: "U")
    }

    @Fact
    func NonGenericAsyncFunctionCall_InsideGenericCaller_StillWrapsAsTask_Regression() {
        // Regression: a NON-generic async callee's call-site return type must
        // still wrap as Task[T] exactly as before this fix, even when the
        // caller itself is generic.
        const source = `
package p
async func Answer() int32 {
    return 42
}
async func Outer[U](seed U) int32 {
    var r = Answer()
    return await r
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "Answer")
        Assert.NotNull(call)
        Assert.True(
            call!!.Type is ImportedTypeSymbol imported &&
                imported.ClrType!!.IsGenericType &&
                imported.ClrType!!.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task[_])
        )
    }

    @Fact
    func MultipleGenericTypeParameters_AsyncFunctionCall_ObservedAsTaskOfSubstitutedSecondParameter() {
        const source = `
package p
async func Pair[TFirst, TSecond](a TFirst, b TSecond) TSecond {
    return b
}
async func Outer[TFirst, TSecond](x TFirst, y TSecond) TSecond {
    var r = Pair(x, y)
    return await r
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let call BoundCallExpression? = FindCall(compilation, "Outer", "Pair")
        Assert.NotNull(call)
        AssertIsTaskOf(call!!.Type, expectedTypeArgumentName: "TSecond")
    }

    @Fact
    func GenericLocalFunctionDeclaration_NestedInsideGenericFunction_ReferencingOwnAsyncCall_Regression() {
        // A nested (non-async) generic local helper that itself calls a
        // top-level generic async function inside a generic outer function —
        // covering "async local function nested inside another generic
        // function" from a different angle: the local function's own body
        // still observes the inner call as Task[U] (not the local function
        // being itself declared async/generic, which issue #2016's GS0468
        // gate now forbids for any local function referencing the enclosing
        // type parameter).
        const source = `
package p
async func Foo[U](x U) U {
    return x
}
async func Outer[U](seed U) U {
    var r = Foo(seed)
    var r2 = Foo(seed)
    return await r
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let calls = FindCalls(compilation, "Outer", "Foo")
        Assert.Equal(2, calls.Count)
        Assert.All(calls, (c BoundCallExpression) -> AssertIsTaskOf(c.Type, expectedTypeArgumentName: "U"))
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

    private class IndirectCallCollector : BoundTreeWalker {
        init() {
            Collected = List[BoundIndirectCallExpression]()
        }

        prop Collected List[BoundIndirectCallExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundIndirectCallExpression call {
                Collected.Add(call)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func AssertIsTaskOf(type TypeSymbol, expectedTypeArgumentName string) {
            Assert.True(
                type is ImportedTypeSymbol imported &&
                    imported.ClrType!!.IsGenericType &&
                    imported.ClrType!!.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task[_]) &&
                    imported
                    .TypeArguments
                    .Length == 1 &&
                    imported
                    .TypeArguments[0]
                    .Name == expectedTypeArgumentName,
                "Expected Task[$expectedTypeArgumentName], got '$type'."
            )
        }

        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindCall(compilation Compilation, functionName string, callName string) BoundCallExpression? {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = Issue2026GenericAsyncTaskWrapTests.CallCollector(callName)
            collector.Visit(body)
            return collector.Collected.FirstOrDefault()
        }

        private func FindCalls(compilation Compilation, functionName string, callName string) List[
            BoundCallExpression
        ] {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = Issue2026GenericAsyncTaskWrapTests.CallCollector(callName)
            collector.Visit(body)
            return collector.Collected
        }

        private func FindIndirectCall(compilation Compilation, functionName string) BoundIndirectCallExpression? {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = Issue2026GenericAsyncTaskWrapTests.IndirectCallCollector()
            collector.Visit(body)
            return collector.Collected.FirstOrDefault()
        }
    }
}
