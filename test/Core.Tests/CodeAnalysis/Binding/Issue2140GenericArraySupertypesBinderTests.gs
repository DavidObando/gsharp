// <copyright file="Issue2140GenericArraySupertypesBinderTests.cs" company="GSharp">
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

/// Issue #2140: a slice `[]T` whose element `T` is a generic type
/// parameter (or same-compilation user type) has a null backing
/// `ClrType` during binding. It must still convert to the element-
/// INDEPENDENT array supertypes that EVERY one-dimensional array carries: the
/// base class (cref:System.Array) and the non-generic collection
/// interfaces ((cref:IEnumerable), (cref:ICollection),
/// (cref:IList)), plus (cref:System.ICloneable),
/// (cref:IStructuralComparable), (cref:IStructuralEquatable).
/// These conversions carry no element type argument, so slice invariance for
/// the generic element interfaces (`IEnumerable[T]` etc.) is unaffected.
open class Issue2140GenericArraySupertypesBinderTests {
    @Fact
    func GenericParamElementArray_ToSystemArray_NoDiagnostics() {
        const source = `
package P
class G[T] {
    func ToArr(arr []T) System.Array { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToNonGenericIEnumerable_NoDiagnostics() {
        const source = `
package P
class G[T] {
    func ToEnum(arr []T) System.Collections.IEnumerable { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToNonGenericICollection_NoDiagnostics() {
        const source = `
package P
class G[T] {
    func ToColl(arr []T) System.Collections.ICollection { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToNonGenericIList_NoDiagnostics() {
        const source = `
package P
class G[T] {
    func ToList(arr []T) System.Collections.IList { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToICloneable_NoDiagnostics() {
        const source = `
package P
class G[T] {
    func ToClone(arr []T) System.ICloneable { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToAllElementIndependentSupertypes_NoDiagnostics() {
        const source = `
package P
class G[T] {
    func ToArr(arr []T) System.Array { return arr }
    func ToEnum(arr []T) System.Collections.IEnumerable { return arr }
    func ToColl(arr []T) System.Collections.ICollection { return arr }
    func ToList(arr []T) System.Collections.IList { return arr }
    func ToClone(arr []T) System.ICloneable { return arr }
    func ToStructComp(arr []T) System.Collections.IStructuralComparable { return arr }
    func ToStructEq(arr []T) System.Collections.IStructuralEquatable { return arr }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func UserTypeElementArray_ToSystemArray_NoDiagnostics() {
        const source = `
package P
struct Segment { let X uint32 }
func ToArr(arr []Segment) System.Array { return arr }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ConcreteElementArray_ToSystemArray_StillNoDiagnostics() {
        // Control: the concrete-element path (backing ClrType non-null) must
        // remain unaffected.
        const source = `
package P
func ToArr(arr []string) System.Array { return arr }
func ToColl(arr []string) System.Collections.ICollection { return arr }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericParamElementArray_ToMismatchedGenericIEnumerable_StillRejected() {
        // Slice invariance for the generic element interfaces must be
        // preserved: []T does NOT convert to IEnumerable[U] for a different U.
        const source = `
package P
import System.Collections.Generic
class G[T, U] {
    func Bad(arr []T) IEnumerable[U] { return arr }
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
        private func GetDiagnostics(source string) Issue2140GenericArraySupertypesBinderTests
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
            return Issue2140GenericArraySupertypesBinderTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
