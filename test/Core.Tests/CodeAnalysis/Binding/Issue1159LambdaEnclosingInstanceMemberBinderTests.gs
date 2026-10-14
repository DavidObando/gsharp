// <copyright file="Issue1159LambdaEnclosingInstanceMemberBinderTests.cs" company="GSharp">
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

/// Issue #1159: an unqualified reference to an enclosing-instance member from
/// inside a lambda / closure body must resolve (capturing `this`) just as
/// it does when written directly in the method body or with an explicit
/// `this.` receiver. Previously the unqualified call path
/// (`H(d)` → GS0130) and the method-group-as-value path
/// (`let fn = H` → GS0125) keyed off the lambda's synthetic enclosing
/// function (which carries no receiver) instead of the enclosing instance
/// method's `this` still visible in lexical scope. Both lambda forms
/// (`func (…) { … }` and `(…) -> …`) and nested lambdas are
/// covered. Static-context behavior is unchanged: a genuinely-undefined name
/// still reports its diagnostic.
open class Issue1159LambdaEnclosingInstanceMemberBinderTests {
    @Fact
    func UnqualifiedInstanceCall_InFuncLiteralLambda_Resolves() {
        let source = `
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            H(d)
        }
        g(1)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func UnqualifiedInstanceCall_InArrowLambda_Resolves() {
        let source = `
class C {
    func H(x int32) { }
    func F() {
        let g = (d int32) -> H(d)
        g(1)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func UnqualifiedInstanceCall_ValueReturningArrowLambda_Resolves() {
        let source = `
class C {
    func H(x int32) int32 { return x }
    func F() {
        let g = (d int32) -> H(d)
        let r int32 = g(1)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func InstanceMethodGroupAsValue_InLambda_Resolves() {
        let source = `
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            let fn = H
            fn(d)
        }
        g(1)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func UnqualifiedInstanceCall_InNestedLambda_Resolves() {
        let source = `
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            let inner = func (e int32) {
                H(e)
            }
            inner(d)
        }
        g(1)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func ExplicitThisCall_InLambda_StillResolves() {
        // Control: the explicit `this.` receiver path already worked and must
        // keep working unchanged.
        let source = `
class C {
    func H(x int32) { }
    func F() {
        let g = func (d int32) {
            this.H(d)
        }
        g(1)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func DirectUnqualifiedInstanceCall_StillResolves() {
        // Control: a non-lambda unqualified instance call must remain unaffected.
        let source = `
class C {
    func H(x int32) { }
    func F() { H(1) }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func UndefinedName_InLambda_InInstanceMethod_StillReportsGS0130() {
        // The implicit-`this` fallback must not invent a resolution for a name
        // that no enclosing instance member defines.
        let source = `
class C {
    func F() {
        let g = func (d int32) {
            Nope(d)
        }
        g(1)
    }
}
`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("Nope"))
    }

    @Fact
    func UndefinedName_InLambda_InStaticMethod_StillReportsGS0130() {
        // Static context: no `this` is in scope, so the effective-`this`
        // lookup yields null and resolution stays unchanged (still errors).
        let source = `
class C {
    shared {
        func F() {
            let g = func (d int32) {
                Nope(d)
            }
            g(1)
        }
    }
}
`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("Nope"))
    }

    @Fact
    func UnqualifiedFieldRead_InLambda_StillResolves() {
        // Control: bare instance field reads already resolved through the
        // implicit-member scope symbols; this must remain unaffected.
        let source = `
class C {
    var state int32 = 10
    func F() int32 {
        let g = func (d int32) int32 { return state + d }
        return g(5)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    shared {
        private func AssertNoErrors(result EmittedOracleResult) {
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
