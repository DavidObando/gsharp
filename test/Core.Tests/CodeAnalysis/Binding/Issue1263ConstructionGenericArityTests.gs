// <copyright file="Issue1263ConstructionGenericArityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1263: a construction `T[X](args)` must resolve the constructed
/// type by the supplied type-argument arity so a non-generic `T` and a
/// same-named generic `T[X]` can coexist. Previously the constructor-call
/// name resolution ignored the explicit type-argument list, bound to the
/// arity-0 `T`, and reported GS0148 ("requires 0 type arguments but was
/// given 1"). This is the construction-site analog of #1051.
open class Issue1263ConstructionGenericArityTests {
    @Fact
    func ConstructGenericWithSiblingNonGeneric_ResolvesGenericArity_NoDiagnostics() {
        const source = `package p
class Op { func M() {} }
class Op[T] { let v T  init(v T) { this.v = v } }
class C { func F() { let x = Op[int32](5) } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ConstructTwoArityGenericWithSiblingNonGeneric_ResolvesArity2_NoDiagnostics() {
        const source = `package p
class Pair { func M() {} }
class Pair[A, B] { let a A  let b B  init(a A, b B) { this.a = a  this.b = b } }
class C { func F() { let x = Pair[int32, string](5, "hi") } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ConstructWithNoMatchingArity_ReportsGS0148() {
        const source = `package p
class Op { func M() {} }
class Op[T] { let v T  init(v T) { this.v = v } }
class C { func F() { let x = Op[int32, int32](5) } }`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0148")
    }

    @Fact
    func ConstructWithoutTypeArgs_PicksNonGeneric_NoDiagnostics() {
        const source = `package p
class Op { init() {} func M() {} }
class Op[T] { let v T  init(v T) { this.v = v } }
class C { func F() { let x = Op() } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ConstructGenericWithoutCollision_StillResolves_NoDiagnostics() {
        const source = `package p
class Op[T] { let v T  init(v T) { this.v = v } }
class C { func F() { let x = Op[int32](5) } }`
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList()
        }
    }
}
