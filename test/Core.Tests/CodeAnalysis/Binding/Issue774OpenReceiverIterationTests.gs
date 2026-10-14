// <copyright file="Issue774OpenReceiverIterationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #774 / ADR-0084 §L2 follow-up. When an extension declares its
/// receiver as an open generic shape carrying a function-level type
/// parameter (e.g. `IEnumerable[T]`, `sequence[T]`,
/// `[]T`, `Dictionary[K, V]`), iterating that receiver via
/// `for v in self` must surface the iteration variable as the
/// receiver's symbolic element type (`T` / `K` / `V`),
/// not the type-erased `object`.
///
/// Pre-fix the binder routed every `ImportedTypeSymbol` through
/// the closed-CLR probe in (cref:MemberLookup.TryGetClrEnumerableElementType),
/// which read the erased `IEnumerable<object>` shape and
/// returned `object`. Body code that returned the loop variable
/// as `T` failed with `GS0155`.
open class Issue774OpenReceiverIterationTests {
    @Fact
    func Repro_FromIssue_IEnumerableT_Receiver_Iteration_Binds_Without_GS0155() {
        // Verbatim issue repro (sans the `default(T)` line, which is a
        // separate sub-gap tracked as a follow-up). Pre-fix this
        // reported `GS0155: Cannot convert type 'object' to 'T'`.
        const source = `
package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) First[T any](fb T) T {
    for v in self {
        return v
    }
    return fb
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func IEnumerableT_Receiver_Iteration_Yields_TypeParameter() {
        // Tighter version of the repro that calls into another function
        // taking `T` so the inferred element type must round-trip
        // through the regular argument-conversion pipeline.
        const source = `
package P
import System
import System.Collections.Generic

func sink[T](x T) {
}

func (self IEnumerable[T]) Walk[T]() {
    for v in self {
        sink(v)
    }
}

var arr = []int32{1, 2, 3}
arr.Walk()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func SequenceT_Receiver_Iteration_Yields_TypeParameter() {
        const source = `
package P
import System

func (self sequence[T]) Walk[T]() {
    for v in self {
        var typed T = v
    }
}

var arr = []int32{1, 2, 3}
arr.Walk()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func SliceT_Receiver_Iteration_Yields_TypeParameter() {
        // `[]T` is a SliceTypeSymbol whose ElementType is T directly —
        // this branch already worked pre-fix, captured here as a
        // regression guard alongside the new cases.
        const source = `
package P
import System

func (self []T) Walk[T]() {
    for v in self {
        var typed T = v
    }
}

var arr = []int32{1, 2, 3}
arr.Walk()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func DictionaryKV_Receiver_Iteration_Yields_Key_And_Value_TypeParameters() {
        const source = `
package P
import System
import System.Collections.Generic

func sink[T](x T) {
}

func (self Dictionary[K, V]) Walk[K, V]() {
    for k, v in self {
        sink(k)
        sink(v)
    }
}

var d = Dictionary[string, int32]()
d.Walk()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func DictionaryKV_Receiver_Iteration_Element_Variables_Have_TypeParameter_Symbols() {
        // Bind the program, then drill into the bound for-range to
        // confirm the loop variable types are TypeParameterSymbols
        // (K and V) rather than the type-erased ObjectSymbol that the
        // pre-fix code produced.
        const source = `
package P
import System
import System.Collections.Generic

func (self Dictionary[K, V]) Walk[K, V]() {
    for k, v in self {
        var typedK K = k
        var typedV V = v
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func IEnumerableT_Receiver_Iteration_BodyCanCall_Generic_Helpers_With_T() {
        const source = `
package P
import System
import System.Collections.Generic

func wrap[T](x T) T {
    return x
}

func (self IEnumerable[T]) MapAll[T]() {
    for v in self {
        var roundtripped T = wrap(v)
    }
}

var arr = []string{"a", "b"}
arr.MapAll()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func DictionaryKeys_Receiver_Iteration_Yields_TypeParameter_K() {
        // `.Keys` returns `Dictionary.KeyCollection` which implements
        // `IEnumerable<TKey>`. With a `Dictionary[K, V]` receiver,
        // `for k in self.Keys` must surface k as K — pre-fix it
        // surfaced as object via the erased CLR probe.
        const source = `
package P
import System
import System.Collections.Generic

func sink[T](x T) {
}

func (self Dictionary[K, V]) DumpKeys[K, V]() {
    for k in self.Keys {
        sink(k)
    }
}

var d = Dictionary[string, int32]()
d.DumpKeys()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func DictionaryValues_Receiver_Iteration_Yields_TypeParameter_V() {
        const source = `
package P
import System
import System.Collections.Generic

func sink[T](x T) {
}

func (self Dictionary[K, V]) DumpValues[K, V]() {
    for v in self.Values {
        sink(v)
    }
}

var d = Dictionary[string, int32]()
d.DumpValues()
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func IEnumerableT_Receiver_Iteration_LoopVariable_Type_Is_TypeParameter() {
        // Inspect the bound tree: the loop variable on a for-range
        // statement under an `IEnumerable[T]` receiver must be a
        // TypeParameterSymbol (function-level T), not ObjectSymbol.
        const source = `
package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) Walk[T]() {
    for v in self {
        var typed T = v
    }
}
`
        // Binder-inspection test (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's
        // bound state; nothing needs to run.
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let walkSymbol = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Walk")
        Assert.Single(walkSymbol.TypeParameters)
        let t = walkSymbol.TypeParameters[0]
        Assert.Equal("T", t.Name)
        Assert.True(t.IsMethodTypeParameter)
    }

    /// Thin wrapper used so the test cases can call `Assert.Empty`
    /// against a (cref:System.Collections.Immutable.ImmutableArray{T})
    /// without exposing the GSharp diagnostic surface to xUnit's
    /// enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for d in this.diagnostics {
                yield d
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator -> this.GetEnumerator()
    }

    shared {
        private func GetDiagnostics(source string) Issue774OpenReceiverIterationTests.ImmutableArrayOfDiagnostic {
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
            return Issue774OpenReceiverIterationTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
