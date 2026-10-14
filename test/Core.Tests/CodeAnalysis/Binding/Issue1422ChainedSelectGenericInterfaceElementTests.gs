// <copyright file="Issue1422ChainedSelectGenericInterfaceElementTests.cs" company="GSharp">
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

/// Issue #1422 (refs #914): a chained `.Select(...).Select(...)` failed on
/// the SECOND `Select` with `GS0159 (Cannot find function Select)` when
/// the first projection's element type was itself a <em>constructed generic
/// interface over an in-scope type parameter</em> (e.g. `IEnumerator[T]`),
/// even though each `Select` bound cleanly in isolation.
///
/// Root cause: when the first `Select`'s result type
/// (`IEnumerable[IEnumerator[T]]`) was projected to its type-erased closed
/// CLR shape, every top-level generic argument was flatly erased to
/// `System.Object` — collapsing the receiver to `IEnumerable<object>`
/// and discarding the nested `IEnumerator<…>` structure. The second
/// `Select`'s generic inference then bound `TSource = object`, which
/// no longer matched the explicitly-typed `(e IEnumerator[T])` selector, so
/// the candidate was dropped (GS0159). The fix erases each argument while
/// preserving its <em>nested</em> generic shape
/// (`IEnumerable<IEnumerator<object>>`), mirroring how the
/// selector's parameter type is erased, so inference recovers the right
/// `TSource`.
open class Issue1422ChainedSelectGenericInterfaceElementTests {
    @Fact
    func ChainedSelect_FirstProjectionGenericInterfaceElement_Binds() {
        // BUG: GS0159 on the SECOND Select — the first projection's element type
        // `IEnumerator[T]` collapsed to object on the chained receiver.
        const source = `
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []int32 ->
    xs.Select((e IEnumerable[T]) -> e.GetEnumerator())
      .Select((e IEnumerator[T]) -> 1)
      .ToArray()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ChainedSelect_ThreeDeep_GenericInterfaceElement_Binds() {
        // A three-deep chain keeps the nested `IEnumerator[T]` element identity
        // across every link.
        const source = `
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []int32 ->
    xs.Select((e IEnumerable[T]) -> e.GetEnumerator())
      .Select((e IEnumerator[T]) -> e)
      .Select((e IEnumerator[T]) -> 1)
      .ToArray()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ChainedSelect_ThenOrderBy_GenericInterfaceElement_Binds() {
        // A chain terminating in a different generic LINQ operator (OrderBy)
        // also recovers the nested element type.
        const source = `
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []IEnumerator[T] ->
    xs.Select((e IEnumerable[T]) -> e.GetEnumerator())
      .OrderBy((e IEnumerator[T]) -> 1)
      .ToArray()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Controls_ConcreteElement_And_SingleSelect_Bind() {
        // Control 1: a fully-concrete element type (no in-scope type parameter)
        // was never affected and still binds.
        const concreteElement = `
package p
import System
import System.Collections.Generic
import System.Linq
func C(xs []IEnumerable[int32]) []int32 ->
    xs.Select((e IEnumerable[int32]) -> e.GetEnumerator())
      .Select((e IEnumerator[int32]) -> 1)
      .ToArray()
`
        // Control 2: each Select binds in isolation (the issue's premise).
        const singleSelect = `
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []int32 ->
    xs.Select((e IEnumerable[T]) -> e.Count()).ToArray()
`
        Assert.Empty(GetDiagnostics(concreteElement))
        Assert.Empty(GetDiagnostics(singleSelect))
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
        private func GetDiagnostics(source string) Issue1422ChainedSelectGenericInterfaceElementTests
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
            return Issue1422ChainedSelectGenericInterfaceElementTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
