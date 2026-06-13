// <copyright file="Issue774OpenReceiverIterationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #774 / ADR-0084 §L2 follow-up. When an extension declares its
/// receiver as an open generic shape carrying a function-level type
/// parameter (e.g. <c>IEnumerable[T]</c>, <c>sequence[T]</c>,
/// <c>[]T</c>, <c>Dictionary[K, V]</c>), iterating that receiver via
/// <c>for v in self</c> must surface the iteration variable as the
/// receiver's symbolic element type (<c>T</c> / <c>K</c> / <c>V</c>),
/// not the type-erased <c>object</c>.
///
/// Pre-fix the binder routed every <c>ImportedTypeSymbol</c> through
/// the closed-CLR probe in <see cref="MemberLookup.TryGetClrEnumerableElementType"/>,
/// which read the erased <c>IEnumerable&lt;object&gt;</c> shape and
/// returned <c>object</c>. Body code that returned the loop variable
/// as <c>T</c> failed with <c>GS0155</c>.
/// </summary>
public class Issue774OpenReceiverIterationTests
{
    [Fact]
    public void Repro_FromIssue_IEnumerableT_Receiver_Iteration_Binds_Without_GS0155()
    {
        // Verbatim issue repro (sans the `default(T)` line, which is a
        // separate sub-gap tracked as a follow-up). Pre-fix this
        // reported `GS0155: Cannot convert type 'object' to 'T'`.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) First[T any](fb T) T {
    for v in self {
        return v
    }
    return fb
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void IEnumerableT_Receiver_Iteration_Yields_TypeParameter()
    {
        // Tighter version of the repro that calls into another function
        // taking `T` so the inferred element type must round-trip
        // through the regular argument-conversion pipeline.
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void SequenceT_Receiver_Iteration_Yields_TypeParameter()
    {
        const string source = @"
package P
import System

func (self sequence[T]) Walk[T]() {
    for v in self {
        var typed T = v
    }
}

var arr = []int32{1, 2, 3}
arr.Walk()
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void SliceT_Receiver_Iteration_Yields_TypeParameter()
    {
        // `[]T` is a SliceTypeSymbol whose ElementType is T directly —
        // this branch already worked pre-fix, captured here as a
        // regression guard alongside the new cases.
        const string source = @"
package P
import System

func (self []T) Walk[T]() {
    for v in self {
        var typed T = v
    }
}

var arr = []int32{1, 2, 3}
arr.Walk()
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void DictionaryKV_Receiver_Iteration_Yields_Key_And_Value_TypeParameters()
    {
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void DictionaryKV_Receiver_Iteration_Element_Variables_Have_TypeParameter_Symbols()
    {
        // Bind the program, then drill into the bound for-range to
        // confirm the loop variable types are TypeParameterSymbols
        // (K and V) rather than the type-erased ObjectSymbol that the
        // pre-fix code produced.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self Dictionary[K, V]) Walk[K, V]() {
    for k, v in self {
        var typedK K = k
        var typedV V = v
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void IEnumerableT_Receiver_Iteration_BodyCanCall_Generic_Helpers_With_T()
    {
        const string source = @"
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

var arr = []string{""a"", ""b""}
arr.MapAll()
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void DictionaryKeys_Receiver_Iteration_Yields_TypeParameter_K()
    {
        // `.Keys` returns `Dictionary.KeyCollection` which implements
        // `IEnumerable<TKey>`. With a `Dictionary[K, V]` receiver,
        // `for k in self.Keys` must surface k as K — pre-fix it
        // surfaced as object via the erased CLR probe.
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void DictionaryValues_Receiver_Iteration_Yields_TypeParameter_V()
    {
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void IEnumerableT_Receiver_Iteration_LoopVariable_Type_Is_TypeParameter()
    {
        // Inspect the bound tree: the loop variable on a for-range
        // statement under an `IEnumerable[T]` receiver must be a
        // TypeParameterSymbol (function-level T), not ObjectSymbol.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) Walk[T]() {
    for v in self {
        var typed T = v
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;
        Assert.Empty(diagnostics);

        var walkSymbol = compilation.GlobalScope.Functions.Single(f => f.Name == "Walk");
        Assert.Single(walkSymbol.TypeParameters);
        var t = walkSymbol.TypeParameters[0];
        Assert.Equal("T", t.Name);
        Assert.True(t.IsMethodTypeParameter);
    }

    private static ImmutableArrayOfDiagnostic GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var parseDiagnostics = tree.Diagnostics;
        var bindDiagnostics = compilation.GlobalScope.Diagnostics;
        var programDiagnostics = compilation.BoundProgram.Diagnostics;
        var all = parseDiagnostics
            .Concat(bindDiagnostics)
            .Concat(programDiagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
        return new ImmutableArrayOfDiagnostic(all);
    }

    /// <summary>
    /// Thin wrapper used so the test cases can call <c>Assert.Empty</c>
    /// against a <see cref="System.Collections.Immutable.ImmutableArray{T}"/>
    /// without exposing the GSharp diagnostic surface to xUnit's
    /// enumerable inference.
    /// </summary>
    private readonly struct ImmutableArrayOfDiagnostic : System.Collections.Generic.IReadOnlyCollection<Diagnostic>
    {
        private readonly System.Collections.Immutable.ImmutableArray<Diagnostic> diagnostics;

        public ImmutableArrayOfDiagnostic(System.Collections.Immutable.ImmutableArray<Diagnostic> diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public int Count => this.diagnostics.Length;

        public System.Collections.Generic.IEnumerator<Diagnostic> GetEnumerator()
        {
            foreach (var d in this.diagnostics)
            {
                yield return d;
            }
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => this.GetEnumerator();
    }
}
