// <copyright file="Issue1915OpenGenericTypeOfBindingTests.cs" company="GSharp">
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

/// Issue #1915 (sub-bug b, binder side): `typeof(List)` — the bare
/// generic-definition name cs2gs already emits for a C# unbound generic
/// (`typeof(List<>)`) — reported GS0113 "Type 'List' doesn't
/// exist" because `BoundScope.TryLookupImportedClass` only ever tried
/// the exact, non-generic reflection name. `Binder.BindTypeOfExpression`
/// now falls back, for a bare simple type-clause with no type-argument list,
/// qualifier, array shape, or nullable suffix, to an arity-suffixed
/// (``1`, ``2`, …) reflection lookup across the file's imports —
/// binding to the CLR open generic type definition when exactly one match
/// exists. This fallback is scoped to `typeof(...)` only; a bare
/// generic name elsewhere (e.g. a variable's declared type) still reports
/// GS0113, since an open generic has no usable members/constructors there.
open class Issue1915OpenGenericTypeOfBindingTests {
    @Fact
    func BareImportedGenericName_TypeOf_BindsToOpenGenericDefinition() {
        let source = `
import System.Collections.Generic

class C {
    func run() {
        let t = typeof(List)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BareImportedGenericName_TwoArity_TypeOf_BindsToOpenGenericDefinition() {
        let source = `
import System.Collections.Generic

class C {
    func run() {
        let t = typeof(Dictionary)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BareGenericName_OutsideTypeOf_StillReportsUndefinedType() {
        // The fallback is intentionally scoped to `typeof(...)` — a bare
        // generic name used as an ordinary variable type has no usable
        // open-generic members/constructors, so it must keep reporting
        // GS0113 rather than silently binding to something unusable.
        let source = `
import System.Collections.Generic

class C {
    func run() {
        let x List = null
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
