// <copyright file="Issue1087GenericBaseCtorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1087: a derived class's base-initializer (`: base(...)`) must be
/// able to resolve an explicit `init(...)` constructor declared on a
/// GENERIC base class. A constructed (closed) generic base symbol does not carry
/// its own explicit-constructor table — those live on the open definition — so
/// resolution must look through to the definition and substitute the type
/// arguments into each candidate constructor's parameter signature. Before the
/// fix the constructed base fell back to its (empty) primary-constructor set and
/// reported a spurious GS0214.
open class Issue1087GenericBaseCtorTests {
    @Fact
    func BaseInitializer_GenericBaseExplicitCtor_CompilesCleanly() {
        // The minimal #1087 repro: explicit init on a generic base, resolved
        // through a closed `Base[int32]`.
        let source = `package p
open class Base[T] {
    init(a int32) { }
}
class Deriv : Base[int32] {
    init() : base(1) { }
}`
        let scope_ = BindSources(source)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializer_NonGenericBaseExplicitCtor_StillCompilesCleanly() {
        // Control: the identical shape with a NON-generic base must keep working.
        let source = `package p
open class Base {
    init(a int32) { }
}
class Deriv : Base {
    init() : base(1) { }
}`
        let scope_ = BindSources(source)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializer_GenericDerivedForwardsTypeArgument_CompilesCleanly() {
        // The derived type is itself generic and forwards its type argument to
        // the generic base (`Deriv[U] : Base[U]`).
        let source = `package p
open class Base[T] {
    init(a int32) { }
}
class Deriv[U] : Base[U] {
    init() : base(1) { }
}`
        let scope_ = BindSources(source)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializer_GenericBaseCtorUsesTypeParameter_SubstitutesAndCompiles() {
        // The base ctor parameter is the type parameter itself: `init(a T)` on
        // `Base[T]` must surface as `init(a int32)` on `Base[int32]`, so the
        // int32 argument matches after substitution.
        let source = `package p
open class Base[T] {
    init(a T) { }
}
class Deriv : Base[int32] {
    init() : base(7) { }
}`
        let scope_ = BindSources(source)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializer_IntermediateGenericBaseInChain_CompilesCleanly() {
        // An intermediate generic base class in the inheritance chain, plus a
        // base ctor whose parameter is the type parameter.
        let source = `package p
open class A[T] {
    init(a T) { }
}
open class B[T] : A[T] {
    init(b T) : base(b) { }
}
class C : B[int32] {
    init() : base(3) { }
}`
        let scope_ = BindSources(source)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializer_GenericBaseWrongArgumentCount_ReportsGs0214() {
        // Negative case: a wrong argument count against a generic base must
        // still report GS0214 (no accessible base constructor).
        let source = `package p
open class Base[T] {
    init(a int32) { }
}
class Deriv : Base[int32] {
    init() : base(1, 2) { }
}`
        let scope_ = BindSources(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0214")
    }

    shared {
        private func BindSources(sources ...string) BoundGlobalScope {
            let trees = ImmutableArray.CreateRange(sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))))
            return Binder.BindGlobalScope(previous: nil, trees)
        }
    }
}
