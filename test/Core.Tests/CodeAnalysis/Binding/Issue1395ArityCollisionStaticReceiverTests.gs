// <copyright file="Issue1395ArityCollisionStaticReceiverTests.cs" company="GSharp">
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

/// Issue #1395: when a non-generic (arity-0) type and a generic type share the
/// same simple name (arity overloading, e.g. `Box` and `Box[T]`,
/// mirroring BCL `Task`/`Task<T>`), a generic static
/// member-access receiver `Name[TypeArg].StaticMember(...)` must resolve
/// the receiver to the arity-N generic type — selected by the supplied
/// type-argument count — rather than the arity-0 type. Before the fix the
/// arity-unaware type lookup preferred the non-generic type, so the generic
/// type's static member could not be found (GS0125 / GS0159). This is the
/// arity-collision counterpart to #1323 (generic static receiver binding) and
/// #1379 (return-type substitution), both of which assumed a single same-name
/// type.
open class Issue1395ArityCollisionStaticReceiverTests {
    @Fact
    func ReproB_MinimalArityCollision_ResolvesBeforeNullableKindDiagnostic() {
        const source = `
package p
class Box { shared { func Make() Box -> Box() } }
class Box[T] { let v T?  shared { func Make(v T) Box[T] -> Box[T]() } }
class C { func F() Box[int32] { return Box[int32].Make(5) } }
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
    }

    @Fact
    func ReproA_ArityCollisionWithInheritance_BindsWithoutDiagnostics() {
        const source = `
package p
import System.Threading
import System.Threading.Tasks

class Mp4File {}
class ChapterInfo {}

open class Op {
    protected init(mp4File Mp4File?) {}
    shared { func FromCompleted(mp4File Mp4File?) Op -> Op(mp4File) }
}

open class Op[TOutput] : Op {
    init(mp4File Mp4File, result TOutput) : base(mp4File) {}
    shared { func FromCompleted(mp4File Mp4File, result TOutput) Op[TOutput] -> Op[TOutput](mp4File, result) }
}

class Caller {
    func Get() Op[ChapterInfo?] {
        return Op[ChapterInfo?].FromCompleted(Mp4File(), nil)
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func NullableTypeArg_ArityCollision_ResolvesBeforeNullableKindDiagnostic() {
        const source = `
package p
class Box { shared { func Make() Box -> Box() } }
class Box[T] { let v T?  shared { func Make(v T) Box[T] -> Box[T]() } }
class C { func F() Box[int32?] { return Box[int32?].Make(5) } }
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
    }

    @Fact
    func NonGenericSameNameStaticCall_ResolvesBeforeNullableKindDiagnostic() {
        const source = `
package p
class Box { shared { func Make() Box -> Box() } }
class Box[T] { let v T?  shared { func Make(v T) Box[T] -> Box[T]() } }
class C { func F() Box { return Box.Make() } }
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
    }

    shared {
        private func GetDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
            return result.Diagnostics
        }
    }
}
