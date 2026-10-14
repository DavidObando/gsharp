// <copyright file="Issue1989MultiArityOpenGenericTypeOfBindingTests.cs" company="GSharp">
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

/// Issue #1989: same-base-name multi-arity BCL generic families broke the
/// #1915 bare-name open-generic `typeof(...)` fallback. `typeof(Func)`
/// stays GS0113 (ambiguous across Func`1..Func`16 — correct, still requires
/// disambiguation) and `typeof(Action)` keeps resolving the non-generic
/// `System.Action` (unchanged, still correct on its own). The NEW
/// explicit-arity form `typeof(Name[_, ...])` (`_` placeholder type
/// arguments, G#'s analogue of C#'s comma-count `Name<>`) lets a
/// caller pick a specific arity out of a same-base-name family, and NEVER
/// falls back to a same-named non-generic type.
open class Issue1989MultiArityOpenGenericTypeOfBindingTests {
    @Fact
    func BareFunc_TypeOf_StillReportsAmbiguousGS0113() {
        let source = `
import System

class C {
    func run() {
        let t = typeof(Func)
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func ExplicitArityOneFunc_TypeOf_BindsToOpenGenericOneArityDefinition() {
        let source = `
import System

class C {
    func run() {
        let t = typeof(Func[_])
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ExplicitArityTwoFunc_TypeOf_BindsToOpenGenericTwoArityDefinition() {
        let source = `
import System

class C {
    func run() {
        let t = typeof(Func[_, _])
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ExplicitArityOneAction_TypeOf_BindsToGenericAction_NotNonGenericAction() {
        let source = `
import System

class C {
    func run() {
        let t = typeof(Action[_])
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func QualifiedExplicitArityValueTask_TypeOf_BindsWithoutNamespaceImport() {
        let source = `
class C {
    func run() {
        let t = typeof(System.Threading.Tasks.ValueTask[_])
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UnboundGenericQualifierNestedType_TypeOf_BindsToOpenNestedDefinition() {
        let source = `
import System.Collections.Generic

class C {
    func run() {
        let t = typeof(Dictionary[_, _].Enumerator)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func FullyQualifiedUnboundGenericQualifierNestedType_TypeOf_Binds() {
        let source = `
class C {
    func run() {
        let t = typeof(System.Collections.Generic.Dictionary[_, _].Enumerator)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NonGenericOuterGenericNestedQualifier_TypeOf_BindsWithNestedSeparators() {
        let source = `
import GSharp.Core.Tests.CodeAnalysis.Binding

class C {
    func run() {
        let t = typeof(Issue3589Outer.Nested[_].Leaf)
    }
}
`
        let result = EmittedOracle.Evaluate(
            []string{source},
            EmittedOracleOptions{References: []string{typeof(Issue3589Outer).Assembly.Location}}
        )
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BareAction_TypeOf_StillResolvesNonGenericAction() {
        let source = `
import System

class C {
    func run() {
        let t = typeof(Action)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ExplicitArityHuge_NoMatch_ReportsUndefinedTypeGS0113() {
        let source = `
import System

class C {
    func run() {
        let t = typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _])
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    /// Issue #2012 (N1): `_` is an ordinary identifier in G#'s grammar
    /// (not a reserved type-name token), so user code can legally declare a
    /// real type literally named `_`. When it does, `typeof(Func[_])`
    /// must bind the type argument to that REAL type (an ordinary closed
    /// generic `Func<_>`) rather than silently reading `_` as
    /// the open-generic placeholder and flipping to unbound `Func`1`.
    @Fact
    func RealTypeNamedUnderscore_TypeOf_BindsToClosedGeneric_NotOpenGeneric() {
        let source = `
import System

class _ {
}

class C {
    func run() {
        let t = typeof(Func[_])
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

open class Issue3589Outer {
    open class Nested[T] {
        open class Leaf { }
    }
}
