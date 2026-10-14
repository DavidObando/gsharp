// <copyright file="Issue2323GenericSliceInterfaceBinderTests.cs" company="GSharp">
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

/// Issue #2323: pins the binder-side acceptance (already implemented by
/// `Conversion.SliceConvertsToInterfaceSymbolically`) of a slice
/// `[]T` converting to each of the five supported one-argument generic
/// collection interfaces — `IEnumerable[T]`, `ICollection[T]`,
/// `IList[T]`, `IReadOnlyList[T]`, `IReadOnlyCollection[T]` —
/// when `T` is a generic type parameter whose backing
/// (cref:GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.ClrType) is
/// `null` during binding. No prior issue (#1162, #2140) had a
/// binder test explicitly covering the generic-type-parameter element case for
/// these five interfaces, only the element-INDEPENDENT non-generic
/// supertypes (#2140) and the same-compilation user-type element case
/// (#1162). The corresponding `Issue2323GenericSliceInterfaceEmitTests`
/// proves the paired emitter fix end-to-end.
open class Issue2323GenericSliceInterfaceBinderTests {
    @Fact
    func GenericParamElementArray_ToIEnumerable_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
class G[T] {
    func ToEnum(arr []T) IEnumerable[T] { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToICollection_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
class G[T] {
    func ToColl(arr []T) ICollection[T] { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToIList_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
class G[T] {
    func ToList(arr []T) IList[T] { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToIReadOnlyList_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
class G[T] {
    func ToRoList(arr []T) IReadOnlyList[T] { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToIReadOnlyCollection_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
class G[T] {
    func ToRoColl(arr []T) IReadOnlyCollection[T] { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToAllFiveInterfaces_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
class G[T] {
    func ToEnum(arr []T) IEnumerable[T] { return arr }
    func ToColl(arr []T) ICollection[T] { return arr }
    func ToList(arr []T) IList[T] { return arr }
    func ToRoList(arr []T) IReadOnlyList[T] { return arr }
    func ToRoColl(arr []T) IReadOnlyCollection[T] { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToMismatchedIList_StillRejected() {
        // Slice invariance must hold: []T does NOT convert to IList[U] for a
        // different generic parameter U.
        const source = `
package P
import System.Collections.Generic
class G[T, U] {
    func Bad(arr []T) IList[U] { return arr }
}
`
        let diags = GetDiagnostics(source)
        Assert.NotEmpty(diags)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155")
    }

    @Fact
    func GenericParamElementArray_ToUnsupportedGenericInterface_StillRejected() {
        // ISet[T] is not one of the five supported array supertype
        // interfaces; a []T slice must not convert to it.
        const source = `
package P
import System.Collections.Generic
class G[T] {
    func Bad(arr []T) ISet[T] { return arr }
}
`
        let diags = GetDiagnostics(source)
        Assert.NotEmpty(diags)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155")
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

        private func (IEnumerable) GetEnumerator() IEnumerator -> this.GetEnumerator()
    }

    shared {
        private func GetDiagnostics(source string) Issue2323GenericSliceInterfaceBinderTests
            .ImmutableArrayOfDiagnostic {
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
            return Issue2323GenericSliceInterfaceBinderTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
