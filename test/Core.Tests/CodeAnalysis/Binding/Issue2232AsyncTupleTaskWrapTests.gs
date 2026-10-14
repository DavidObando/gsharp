// <copyright file="Issue2232AsyncTupleTaskWrapTests.cs" company="GSharp">
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

/// Issue #2232: an `async func` whose declared (implicit-wrap) return type
/// is a tuple containing a still-in-flight user-defined element — e.g.
/// `(bool, UserClass)` or `(bool, IUserInterface)` — must observe its
/// call-site result as `Task[(bool, UserType)]`, so `await F()`
/// yields the bare tuple. (cref:TupleTypeSymbol) reports a `null`
/// (cref:TypeSymbol.ClrType) when any element lacks a CLR backing type,
/// which previously fell through (cref:LambdaBinder.WrapAsTask)'s
/// symbolic branch (that only special-cased `struct`/`interface`/
/// `enum`/type-parameter elements), silently dropping the `Task`
/// wrapper. The bare tuple then failed `await` with GS0133 ("cannot be
/// awaited"), cascading GS0125 onto any deconstructed bindings. A tuple whose
/// elements are all BCL types (e.g. `(bool, string)`) was unaffected
/// because its `ValueTuple<...>` ClrType resolves.
open class Issue2232AsyncTupleTaskWrapTests {
    @Fact
    func AsyncFunc_ReturningTupleWithUserClassElement_Awaited_ObservedAsTaskOfTuple() {
        const source = `
package p
class Box { }
async func Producer() (bool, Box) {
    return (true, Box())
}
async func Consume() bool {
    let t = await Producer()
    return t.Item1
}
`
        let compilation = Compile(source)
        AssertNoAwaitOrScopeErrors(compilation)
        let call BoundCallExpression? = FindCall(compilation, "Consume", "Producer")
        Assert.NotNull(call)
        AssertIsTaskOfTuple(call!!.Type)
    }

    @Fact
    func AsyncFunc_ReturningTupleWithUserClassElement_AwaitedAndDeconstructed_NoGS0125() {
        const source = `
package p
class Box { }
async func Producer() (bool, Box) {
    return (true, Box())
}
async func Consume() bool {
    let (ok, x) = await Producer()
    return ok
}
`
        let compilation = Compile(source)
        AssertNoAwaitOrScopeErrors(compilation)
    }

    @Fact
    func AsyncFunc_ReturningTupleWithUserInterfaceElement_Awaited_NoGS0133() {
        const source = `
package p
interface IProfile { func Name() string; }
async func Producer(p IProfile) (bool, IProfile) {
    return (true, p)
}
async func Consume(p IProfile) bool {
    let (ok, prof) = await Producer(p)
    return ok
}
`
        let compilation = Compile(source)
        AssertNoAwaitOrScopeErrors(compilation)
        let call BoundCallExpression? = FindCall(compilation, "Consume", "Producer")
        Assert.NotNull(call)
        AssertIsTaskOfTuple(call!!.Type)
    }

    @Fact
    func AsyncFunc_ReturningTupleWithAllBclElements_StillWrapsAsTask_Regression() {
        // A tuple whose elements are all BCL types keeps a resolvable
        // ValueTuple ClrType and never depended on the fix; pin it stays green.
        const source = `
package p
async func Producer() (bool, string) {
    return (true, "s")
}
async func Consume() bool {
    let (ok, s) = await Producer()
    return ok
}
`
        let compilation = Compile(source)
        AssertNoAwaitOrScopeErrors(compilation)
        let call BoundCallExpression? = FindCall(compilation, "Consume", "Producer")
        Assert.NotNull(call)
        Assert.True(
            call!!.Type is ImportedTypeSymbol imported &&
                imported.ClrType!!.IsGenericType &&
                imported.ClrType!!.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task[_]),
            "Expected Task[...], got '${call!!.Type}'."
        )
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
        private func AssertNoAwaitOrScopeErrors(compilation Compilation) {
            Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, (d Diagnostic) -> d.Id == "GS0133")
            Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        }

        private func AssertIsTaskOfTuple(type TypeSymbol) {
            Assert.True(
                type is ImportedTypeSymbol imported &&
                    imported.ClrType!!.IsGenericType &&
                    imported.ClrType!!.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task[_]) &&
                    imported
                    .TypeArguments
                    .Length == 1 &&
                    imported.TypeArguments[0] is TupleTypeSymbol,
                "Expected Task[(...)] over a tuple, got '$type'."
            )
        }

        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindCall(compilation Compilation, functionName string, callName string) BoundCallExpression? {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = Issue2232AsyncTupleTaskWrapTests.CallCollector(callName)
            collector.Visit(body)
            return collector.Collected.FirstOrDefault()
        }
    }
}
