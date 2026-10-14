// <copyright file="Issue1124GenericUninferableOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1124. When a method group contains a generic overload whose method
/// type parameter cannot be inferred from the arguments (it appears only in the
/// return type / a constraint) alongside a non-generic overload with a matching
/// parameter list, a call without explicit type arguments must exclude the
/// generic candidate (C# §11.6.4.2: type inference failure makes the method
/// inapplicable) and bind the unique non-generic overload — not report GS0266
/// ambiguity. Explicit type arguments must still select the generic overload,
/// inferable generics must still participate, and genuinely ambiguous calls
/// must still report GS0266.
open class Issue1124GenericUninferableOverloadTests {
    @Fact
    func UninferableGeneric_PlusNonGeneric_ResolvesToNonGeneric_NoDiagnostics() {
        const source = `
package p
interface IBox {}
class Box : IBox {}
class Factory {
    shared {
        func Make[T Box](file int32, parent IBox?) T { return default(T) }
        func Make(file int32, parent IBox?) IBox { return Box() }
    }
}
class C {
    func G(b IBox) {
        let child = Factory.Make(5, b)
    }
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let make BoundCallExpression? = FindCall(compilation, "G", "Make")
        Assert.NotNull(make)
        Assert.False(make!!.Function.IsGeneric)
    }

    @Fact
    func ExplicitTypeArguments_SelectGenericOverload() {
        const source = `
package p
interface IBox {}
class Box : IBox {}
class Factory {
    shared {
        func Make[T Box](file int32, parent IBox?) T { return default(T) }
        func Make(file int32, parent IBox?) IBox { return Box() }
    }
}
class C {
    func G(b IBox) {
        let child = Factory.Make[Box](5, b)
    }
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let make BoundCallExpression? = FindCall(compilation, "G", "Make")
        Assert.NotNull(make)
        Assert.True(make!!.Function.IsGeneric)
    }

    @Fact
    func InferableGeneric_StillParticipates_NoDiagnostics() {
        // The generic overload's type parameter is inferable from the first
        // argument, and a non-generic overload of a different arity exists. The
        // two-argument call must bind the generic overload (T inferred from the
        // argument); the one-argument call must bind the non-generic overload.
        const source = `
package p
interface IBox {}
class Box : IBox {}
class Factory {
    shared {
        func Make[T Box](item T, file int32) T { return item }
        func Make(file int32) IBox { return Box() }
    }
}
class C {
    func G(box Box) {
        let a = Factory.Make(box, 5)
        let b = Factory.Make(7)
    }
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let calls = FindCalls(compilation, "G", "Make")
        Assert.Equal(2, calls.Count)
        Assert.Contains(calls, (c BoundCallExpression) -> c.Function.IsGeneric)
        Assert.Contains(calls, (c BoundCallExpression) -> !c.Function.IsGeneric)
    }

    @Fact
    func GenuineAmbiguity_BetweenNonGenericOverloads_StillReportsGS0266() {
        const source = `
package p
interface IA {}
interface IB {}
class Both : IA, IB {}
class Factory {
    shared {
        func Take(x IA) int32 { return 1 }
        func Take(x IB) int32 { return 2 }
    }
}
class C {
    func G(b Both) {
        let x = Factory.Take(b)
    }
}
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0266")
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
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindCall(
            compilation Compilation,
            functionName string,
            callName string
        ) BoundCallExpression? -> FindCalls(compilation, functionName, callName).FirstOrDefault()

        private func FindCalls(compilation Compilation, functionName string, callName string) List[
            BoundCallExpression
        ] {
            let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let body = compilation.BoundProgram.Functions[fn]
            let collector = Issue1124GenericUninferableOverloadTests.CallCollector(callName)
            collector.Visit(body)
            return collector.Collected
        }
    }
}
