// <copyright file="Issue1162UserElementArrayBinderTests.cs" company="GSharp">
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

/// Issue #1162: a slice `[]T` whose element `T` is a
/// same-compilation user type (struct / class / enum) has a null backing
/// `ClrType` during binding. These binder-level tests assert that the
/// three affected paths now report no diagnostics: the (cref:System.Array)
/// member surface (`.Length`), the `[]T → IEnumerable[T]` /
/// `IReadOnlyList[T]` conversion, and `IEnumerable<T>`
/// extension (LINQ) resolution — while primitive-element controls keep working
/// and genuinely incompatible element types are still rejected.
open class Issue1162UserElementArrayBinderTests {
    @Fact
    func StructElementArray_Length_NoDiagnostics() {
        const source = `
package P
struct Segment { let X uint32 }
func Len(xs []Segment) int32 { return xs.Length }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ClassElementArray_Length_NoDiagnostics() {
        const source = `
package P
class Seg { public let X int32 = 0 }
func Len(xs []Seg) int32 { return xs.Length }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func EnumElementArray_Length_NoDiagnostics() {
        const source = `
package P
enum Color { Red, Green, Blue }
func Len(xs []Color) int32 { return xs.Length }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StructElementArray_ToIEnumerable_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
struct Segment { let X uint32 }
func Take(e IEnumerable[Segment]) int32 { return 0 }
func F(xs []Segment) int32 { return Take(xs) }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StructElementArray_ToIReadOnlyList_NoDiagnostics() {
        const source = `
package P
import System.Collections.Generic
struct Segment { let X uint32 }
func Take(e IReadOnlyList[Segment]) int32 { return 0 }
func F(xs []Segment) int32 { return Take(xs) }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StructElementArray_LinqSum_NoDiagnostics() {
        const source = `
package P
import System.Linq
struct Segment { let ReferenceSize uint32 }
func F(segs []Segment) int64 { return segs.Sum((s Segment) -> int64(s.ReferenceSize)) }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ClassElementArray_LinqWhereCount_NoDiagnostics() {
        const source = `
package P
import System.Linq
class Seg { public let X int32 = 0 }
func F(xs []Seg) int32 { return xs.Where((s Seg) -> s.X > 0).Count() }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func PrimitiveElementArray_LengthAndLinq_StillBind() {
        const source = `
package P
import System.Linq
func F(xs []int32) int32 { return xs.Sum() }
func G(xs []int32) int32 { return xs.Where((x int32) -> x > 0).Count() }
func F2(xs []int32) int32 { return xs.Length }
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Negative_StructElementArray_ToMismatchedIEnumerable_Rejected() {
        // Slice invariance must hold for user types too: a []SegA does NOT
        // convert to IEnumerable[SegB].
        const source = `
package P
import System.Collections.Generic
struct SegA { let X uint32 }
struct SegB { let Y uint32 }
func Take(e IEnumerable[SegB]) int32 { return 0 }
func F(xs []SegA) int32 { return Take(xs) }
`
        let diags = GetDiagnostics(source)
        Assert.NotEmpty(diags)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155")
    }

    @Fact
    func Negative_FixedStructArray_ToMismatchedIEnumerable_Rejected() {
        const source = `
package P
import System.Collections.Generic
struct SegA { let X uint32 }
struct SegB { let Y uint32 }
func Take(e IEnumerable[SegB]) int32 { return 0 }
func F(xs [3]SegA) int32 { return Take(xs) }
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

        private func (IEnumerable) GetEnumerator() IEnumerator {
            return GetEnumerator()
        }
    }

    shared {
        private func GetDiagnostics(source string) Issue1162UserElementArrayBinderTests.ImmutableArrayOfDiagnostic {
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
            return Issue1162UserElementArrayBinderTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
