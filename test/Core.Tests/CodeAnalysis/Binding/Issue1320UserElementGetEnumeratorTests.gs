// <copyright file="Issue1320UserElementGetEnumeratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1320: `GetEnumerator()` (and the `IEnumerable<T>`
/// member surface generally) could not be resolved on a `sequence[UserType]`
/// (an iterator return type, alias for `IEnumerable<UserType>`) or on
/// a user-element array `[]UserType`, while the identical call resolved on a
/// primitive element type and on an explicitly-typed `IEnumerable[UserType]`
/// / `List[UserType]`. The root cause: those receivers have a
/// `null` `ClrType` during binding (the element type is not
/// yet emitted), so the CLR member-lookup path dead-ended with GS0159. These
/// binder-level tests mirror the issue's repro matrix: the formerly broken
/// `sequence[UserType]` case now resolves to the generic
/// `IEnumerator[UserType]` overload, the user-element array now finds the
/// member at parity with a primitive array, and every control keeps working.
open class Issue1320UserElementGetEnumeratorTests {
    @Fact
    func SequenceUserElement_GetEnumerator_ResolvesGenericOverload() {
        // BUG line (Oahu blocker): SeqUser().GetEnumerator() must resolve to
        // IEnumerator[E] so the IEnumerator[E] return type binds.
        const source = `
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func SeqUser() sequence[E] { yield E{X:1} }
    func UseSeq() IEnumerator[E] -> SeqUser().GetEnumerator()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func SequenceClassElement_GetEnumerator_ResolvesGenericOverload() {
        const source = `
package p
import System.Collections.Generic
class Seg { public var X int32 = 0 }
class C {
    func SeqSeg() sequence[Seg] { yield Seg() }
    func UseSeq() IEnumerator[Seg] -> SeqSeg().GetEnumerator()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func SequencePrimitiveElement_GetEnumerator_StillResolves() {
        // Control: the primitive sequence path is unchanged.
        const source = `
package p
import System.Collections.Generic
class C {
    func SeqPrim() sequence[int32] { yield 1 }
    func UsePrim() IEnumerator[int32] -> SeqPrim().GetEnumerator()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func IEnumerableUserElement_GetEnumerator_StillResolves() {
        // Control: the explicitly-typed IEnumerable[E] parameter path is unchanged.
        const source = `
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func FromIface(xs IEnumerable[E]) IEnumerator[E] -> xs.GetEnumerator()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ListUserElement_GetEnumerator_StillResolves() {
        // Control: the explicitly-typed List[E] parameter path is unchanged.
        const source = `
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func FromList(xs List[E]) IEnumerator[E] -> xs.GetEnumerator()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func UserElementArray_GetEnumerator_FindsMemberAtPrimitiveParity() {
        // The user-element array now FINDS GetEnumerator (resolving the
        // non-generic IEnumerator overload), exactly like a primitive array —
        // previously GS0159 ("Cannot find function GetEnumerator"). Both the
        // user-element and primitive arrays must produce identical diagnostics.
        const userSource = `
package p
import System.Collections
struct E { var X int32 }
class C {
    func FromArr(xs []E) IEnumerator -> xs.GetEnumerator()
}
`
        const primitiveSource = `
package p
import System.Collections
class C {
    func FromArr(xs []int32) IEnumerator -> xs.GetEnumerator()
}
`
        Assert.Empty(GetDiagnostics(userSource))
        Assert.Empty(GetDiagnostics(primitiveSource))
    }

    @Fact
    func UserElementArray_GetEnumerator_NoLongerReportsCannotFindFunction() {
        // Even when forced to the generic IEnumerator[E] return (which, at
        // parity with a primitive array, the non-generic GetEnumerator cannot
        // satisfy → GS0155), the member is now FOUND: the diagnostic is a
        // conversion error, never GS0159 ("Cannot find function").
        const userSource = `
package p
import System.Collections.Generic
struct E { var X int32 }
class C {
    func FromArr(xs []E) IEnumerator[E] -> xs.GetEnumerator()
}
`
        const primitiveSource = `
package p
import System.Collections.Generic
class C {
    func FromArr(xs []int32) IEnumerator[int32] -> xs.GetEnumerator()
}
`
        let userDiags = GetDiagnostics(userSource)
        let primitiveDiags = GetDiagnostics(primitiveSource)
        // Parity: the user-element array now behaves exactly like the primitive
        // array (both GS0155), where it previously reported GS0159.
        Assert.DoesNotContain(userDiags, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal(
            primitiveDiags.Select((d Diagnostic) -> d.Id).OrderBy((id string) -> id),
            userDiags.Select((d Diagnostic) -> d.Id).OrderBy((id string) -> id)
        )
    }

    /// Thin wrapper so the test cases can call `Assert.Empty` against a
    /// (cref:ImmutableArray{T}) without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for diagnostic in this.diagnostics {
                yield diagnostic
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator {
            return GetEnumerator()
        }
    }

    shared {
        private func GetDiagnostics(source string) Issue1320UserElementGetEnumeratorTests.ImmutableArrayOfDiagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            let all = parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return Issue1320UserElementGetEnumeratorTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
