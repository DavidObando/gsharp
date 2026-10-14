// <copyright file="Issue1335LambdaProtectedAccessBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1335: a `protected`/`private` member of the enclosing class
/// referenced from inside a lambda / function-literal declared in the same class
/// must have the same access as the enclosing member (matching C#). Previously
/// the bind-time accessibility check lost the enclosing-type context inside the
/// closure body — it keyed off the lambda's synthetic function (which carries no
/// receiver) — and wrongly reported `GS0379`. These binder tests pin the
/// fix for both lambda forms (`func (…) { … }` and `(…) -> …`),
/// nested lambdas, and inherited `protected` members, while confirming that
/// genuine inaccessibility (an unrelated class's `protected` member) still
/// reports `GS0379`.
open class Issue1335LambdaProtectedAccessBinderTests {
    @Fact
    func ProtectedAndPrivateCall_InFuncLiteralLambda_NoGS0379() {
        let source = `
open class C {
    protected func Prot() int32 { return 1 }
    private func Priv() int32 { return 2 }
    func F() int32 {
        let g = func () int32 { return Prot() + Priv() }
        return g()
    }
}
`
        AssertNoGS0379(Evaluate(source))
    }

    @Fact
    func ProtectedAndPrivateCall_InArrowLambda_NoGS0379() {
        let source = `
open class C {
    protected func Prot() int32 { return 1 }
    private func Priv() int32 { return 2 }
    func F() int32 {
        let g = (d int32) -> Prot() + Priv() + d
        return g(1)
    }
}
`
        AssertNoGS0379(Evaluate(source))
    }

    @Fact
    func PrivateFieldAndProtectedProperty_InLambda_NoGS0379() {
        let source = `
open class C {
    private var f int32 = 5
    protected prop P int32 { get { return 9 } }
    func F() int32 {
        let g = func () int32 { return f + P }
        return g()
    }
}
`
        AssertNoGS0379(Evaluate(source))
    }

    @Fact
    func InheritedProtectedMember_InLambda_NoGS0379() {
        let source = `
open class Base {
    protected func BaseHelper() int32 { return 7 }
}
open class Derived : Base {
    func F() int32 {
        let g = func () int32 { return BaseHelper() }
        return g()
    }
}
`
        AssertNoGS0379(Evaluate(source))
    }

    @Fact
    func NestedLambda_ProtectedAndPrivate_NoGS0379() {
        let source = `
open class C {
    protected func Prot() int32 { return 1 }
    private func Priv() int32 { return 2 }
    func F() int32 {
        let outer = func () int32 {
            let inner = func () int32 { return Prot() + Priv() }
            return inner()
        }
        return outer()
    }
}
`
        AssertNoGS0379(Evaluate(source))
    }

    @Fact
    func UnrelatedClassProtectedMember_InLambda_StillReportsGS0379() {
        // Genuine inaccessibility must still be reported: a `protected` member of
        // an unrelated class accessed from a lambda is not made accessible by the
        // enclosing-type fallback.
        let source = `
open class Other {
    protected func Secret() int32 { return 1 }
}
class C {
    func F() int32 {
        let o = Other{}
        let g = func () int32 { return o.Secret() }
        return g()
    }
}
`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    shared {
        private func AssertNoGS0379(result EmittedOracleResult) {
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
