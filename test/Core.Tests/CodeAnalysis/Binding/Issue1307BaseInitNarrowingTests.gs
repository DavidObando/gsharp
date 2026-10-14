// <copyright file="Issue1307BaseInitNarrowingTests.cs" company="GSharp">
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
import Xunit

/// Issue #1307 — a base-constructor initializer (`: base(<literal>)`)
/// must apply the same implicit constant-narrowing / integer-literal adaptation
/// (C# §10.2.11, issues #1281/#1306) that ordinary calls and direct
/// constructions already apply. The base-init argument-binding path previously
/// bypassed that pass, so `: base(5)` against a `uint8` constructor
/// failed overload resolution with GS0214 even though literal `5` adapts
/// to `uint8` everywhere else.
open class Issue1307BaseInitNarrowingTests {
    @Fact
    func BaseInitLiteralAdaptsToNarrowerExplicitCtor_BindsWithoutDiagnostics() {
        let source = `
package p
open class B {
    init(t uint8) {}
}
class D : B {
    init() : base(5) {}
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BaseInitLiteralAdaptsToNarrowerPrimaryCtor_BindsWithoutDiagnostics() {
        let source = `
package p
open class B(t uint8) {}
class D : B {
    init() : base(5) {}
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BaseInitWithNoNarrowingNeeded_StillBindsWithoutDiagnostics() {
        let source = `
package p
open class C {
    init(t int32) {}
}
class E : C {
    init() : base(5) {}
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BaseInitWithExplicitCast_StillBindsWithoutDiagnostics() {
        let source = `
package p
open class B {
    init(t uint8) {}
}
class D2 : B {
    init() : base(uint8(5)) {}
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BaseInitOutOfRangeLiteral_StillReportsDiagnostic() {
        let source = `
package p
open class B {
    init(t uint8) {}
}
class D : B {
    init() : base(300) {}
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
