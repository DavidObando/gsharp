// <copyright file="Issue1379GenericStaticReturnSubstitutionTests.cs" company="GSharp">
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

/// Issue #1379: a `shared` (static) method on a user-defined generic type
/// whose return type (and/or parameter types) reference the type's own type
/// parameter must have the receiver's type argument substituted at the call
/// site. `Box[int32].Make()` returning `Box[T]` must be typed
/// `Box[int32]` — not the raw/open `Box`, which fails the conversion
/// to the closed construction (GS0155). This is the user-defined counterpart of
/// the imported-generic fix in issue #1216 and exercises the binding receiver
/// added in issue #1323 (whose tests only used a non-generic static return type,
/// so the return-type substitution path was never covered).
open class Issue1379GenericStaticReturnSubstitutionTests {
    @Fact
    func StaticReturnReferencingT_BindsToClosedConstruction() {
        const source = `
package p
struct Box[T] { shared { func Make() Box[T] -> Box[T]{} } }
class C { func F() Box[int32] { return Box[int32].Make() } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StaticReturnAndParamReferencingT_BindsWithoutDiagnostics() {
        const source = `
package p
struct Box[T] { var V T shared { func Make(v T) Box[T] -> Box[T]{ V: v } } }
class C { func F() Box[int32] { return Box[int32].Make(5) } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StaticReturnReferencingT_WithNullableTypeArg_BindsWithoutDiagnostics() {
        const source = `
package p
struct Info { var X int32 }
struct Box[T] { var V T shared { func Make(v T) Box[T] -> Box[T]{ V: v } } }
class C { func F(i Info?) Box[Info?] { return Box[Info?].Make(i) } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StaticReturnNotReferencingT_StillBindsWithoutDiagnostics() {
        // Control: a static method whose return type does NOT reference T keeps
        // working unchanged.
        const source = `
package p
struct Box[T] { shared { func Make() int32 -> 5 } }
class C { func F() int32 { return Box[int32].Make() } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    shared {
        private func GetDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
            return result.Diagnostics
        }
    }
}
