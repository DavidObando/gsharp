// <copyright file="Issue821SliceToInterfaceAtArgumentSlotBindingTests.cs" company="GSharp">
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

/// Issue #821: a G# slice `[]T` must implicitly convert to every
/// interface implemented by its backing CLR array `T[]`
/// (`IEnumerable<T>`, `IReadOnlyList<T>`,
/// `IList<T>`, `ICollection<T>`, the non-generic
/// counterparts, etc.) at every ordinary argument slot — including
/// static-method (shared) call sites and free-function call sites — not
/// just at receiver positions on extension/instance dispatch
/// (closed by #774's open-generic receiver fix).
/// @remarks The conversion is classified by
/// (cref:GSharp.Core.CodeAnalysis.Binding.Conversion.Classify(Symbols.TypeSymbol, Symbols.TypeSymbol))
/// via the slice-to-interface arm (originally landed for issue #570). The
/// substitution path in `Binder.SubstituteType` rebuilds an
/// `IEnumerable[T]` parameter into a closed CLR
/// (cref:System.Collections.Generic.IEnumerable{T}) at the call site,
/// so the slice-to-interface classifier sees the correctly-shaped target
/// and admits the implicit, no-op conversion. These tests pin that
/// behaviour at all the argument slots the issue body enumerates.
open class Issue821SliceToInterfaceAtArgumentSlotBindingTests {
    @Fact
    func IssueRepro_StaticGenericIndexed_IEnumerableOfT_FromSliceOfT_Binds() {
        // The literal repro from the issue body: `Sequences.Indexed[int32](ints)`
        // where `ints` is a `[]int32` slice and the parameter is `IEnumerable[T]`.
        const source = `
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
            var index = 0
            for v in source {
                yield (index, v)
                index = index + 1
            }
        }
    }
}

let ints = []int32{10, 20, 30}
for p in Sequences.Indexed[int32](ints) {
    let _x = p.Item1
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StaticMethodArgSlot_SliceOfInt_To_IEnumerableOfInt_Binds() {
        // Non-generic shared method taking `IEnumerable[int32]` directly.
        // The argument is a `[]int32` slice literal.
        const source = `
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take(source IEnumerable[int32]) int32 { return 0 }
    }
}

let _ = Sink.Take([]int32{1, 2, 3})
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func FreeFunctionArgSlot_SliceOfString_To_IEnumerableOfString_Binds() {
        // Free-function call slot: `[]string` argument flows into a
        // top-level function parameter typed as `IEnumerable[string]`.
        const source = `
package P
import System.Collections.Generic

func Take(source IEnumerable[string]) int32 { return 0 }

let _ = Take([]string{"a", "b"})
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func FreeFunctionArgSlot_GenericIndexed_SliceOfInt_To_IEnumerableOfT_Binds() {
        // Free-function generic method with an `IEnumerable[T]` parameter
        // — confirms the substitution path (`Binder.SubstituteType`)
        // rebuilds the closed `IEnumerable<int32>` before classification.
        const source = `
package P
import System.Collections.Generic

func Indexed[T](source IEnumerable[T]) int32 { return 0 }

let _ = Indexed[int32]([]int32{10, 20, 30})
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StaticMethodArgSlot_SliceOfInt_To_IListOfInt_Binds() {
        // `IList[T]` is implemented by `T[]` — slice must convert.
        const source = `
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IList[T]) int32 { return source.Count }
    }
}

let _ = Sink.Take[int32]([]int32{1, 2, 3})
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StaticMethodArgSlot_SliceOfInt_To_ICollectionOfInt_Binds() {
        // `ICollection[T]` is implemented by `T[]` — slice must convert.
        const source = `
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source ICollection[T]) int32 { return source.Count }
    }
}

let _ = Sink.Take[int32]([]int32{1, 2, 3})
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StaticMethodArgSlot_SliceOfInt_To_IReadOnlyListOfInt_Binds() {
        // `IReadOnlyList[T]` is implemented by `T[]` — slice must convert.
        const source = `
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IReadOnlyList[T]) int32 { return source.Count }
    }
}

let _ = Sink.Take[int32]([]int32{1, 2, 3})
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Negative_SliceOfInt_To_IEnumerableOfString_Rejected() {
        // G# slices are invariant: `[]int32` must NOT convert to
        // `IEnumerable[string]`. The binder rejects with GS0154
        // ("Parameter requires …") — the standard overload-resolution
        // argument-type mismatch diagnostic.
        const source = `
package P
import System.Collections.Generic

func Take(source IEnumerable[string]) int32 { return 0 }

let _ = Take([]int32{1, 2, 3})
`
        let diags = GetDiagnostics(source)
        Assert.NotEmpty(diags)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155")
    }

    @Fact
    func SliceOfString_ToCovariantIEnumerableOfObject_Accepted() {
        const source = `
package P
import System.Collections.Generic

func Take(source IEnumerable[object]) int32 { return 0 }

let _ = Take([]string{"a", "b"})
`
        let diags = GetDiagnostics(source)
        Assert.Empty(diags)
    }

    /// Thin wrapper used so the test cases can call `Assert.Empty`
    /// against a (cref:ImmutableArray{T}) without exposing the
    /// GSharp diagnostic surface to xUnit's enumerable inference.
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
        private func GetDiagnostics(source string) Issue821SliceToInterfaceAtArgumentSlotBindingTests
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
            return Issue821SliceToInterfaceAtArgumentSlotBindingTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
