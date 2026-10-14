// <copyright file="Issue1323GenericStaticReceiverBinderTests.cs" company="GSharp">
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

/// Issue #1323: binding a generic static member-access receiver
/// `Type[TypeArg].StaticMember(...)` where the single type argument is
/// nullable (`T?`), an array/slice (`[]T`), or a nested generic
/// (`List[T]`). The parser emits a `GenericNameExpression` receiver
/// for these (and for the multi-argument shape); the binder must resolve it to
/// the closed construction and bind the static call without diagnostics.
open class Issue1323GenericStaticReceiverBinderTests {
    @Fact
    func NullableTypeArg_StaticCall_BindsWithoutDiagnostics() {
        const source = `
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32?].Make(5) } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ArrayTypeArg_StaticCall_BindsWithoutDiagnostics() {
        const source = `
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[[]int32].Make(5) } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func NestedGenericTypeArg_StaticCall_BindsWithoutDiagnostics() {
        const source = `
package p
import System.Collections.Generic
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[List[int32]].Make(5) } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func MultiTypeArg_StaticCall_BindsWithoutDiagnostics() {
        const source = `
package p
struct Pair[T, U] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Pair[int32, string].Make(5) } }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func SimpleTypeArg_StaticCall_StillBindsWithoutDiagnostics() {
        const source = `
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32].Make(5) } }
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
