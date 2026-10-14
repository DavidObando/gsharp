// <copyright file="Issue1060BaseInitChainingBinderTests.cs" company="GSharp">
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

/// Issue #1060 — binder-level tests confirming that a derived class's
/// constructor initializer (`init(...) : base(args)`) resolves against the
/// base class's explicit `init(...)` member constructors (and a primary
/// constructor when present), not only the primary constructor. The previously
/// failing repros must now bind with zero diagnostics; a genuinely-missing base
/// constructor must still report GS0214.
open class Issue1060BaseInitChainingBinderTests {
    @Fact
    func ChainToSingleExplicitBaseInit_BindsWithoutDiagnostics() {
        let source = `
package p
open class A {
    var X int32
    init(x int32) { X = x }
}
class B : A {
    init(x int32) : base(x) { }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SelectsAmongMultipleExplicitBaseInits_BindsWithoutDiagnostics() {
        let source = `
package p
open class A {
    init(x int32) {}
    init(x int32, y int32) {}
}
class B : A {
    init() : base(1, 2) { }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ChainToBasePrimaryConstructor_StillBindsWithoutDiagnostics() {
        let source = `
package p
open class A(X int32) {}
class B : A {
    init(x int32) : base(x) {}
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NoMatchingBaseConstructor_ReportsGs0214() {
        let source = `
package p
open class A {
    init(x int32) {}
}
class B : A {
    init() : base("nope") {}
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0214")
    }

    @Fact
    func WrongArgumentCountForExplicitBaseInit_ReportsGs0214() {
        let source = `
package p
open class A {
    init(x int32) {}
}
class B : A {
    init() : base(1, 2) {}
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0214")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
