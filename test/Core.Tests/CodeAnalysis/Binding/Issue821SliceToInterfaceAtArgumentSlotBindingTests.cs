// <copyright file="Issue821SliceToInterfaceAtArgumentSlotBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #821: a G# slice <c>[]T</c> must implicitly convert to every
/// interface implemented by its backing CLR array <c>T[]</c>
/// (<c>IEnumerable&lt;T&gt;</c>, <c>IReadOnlyList&lt;T&gt;</c>,
/// <c>IList&lt;T&gt;</c>, <c>ICollection&lt;T&gt;</c>, the non-generic
/// counterparts, etc.) at every ordinary argument slot — including
/// static-method (shared) call sites and free-function call sites — not
/// just at receiver positions on extension/instance dispatch
/// (closed by #774's open-generic receiver fix).
/// </summary>
/// <remarks>
/// The conversion is classified by
/// <see cref="GSharp.Core.CodeAnalysis.Binding.Conversion.Classify(Symbols.TypeSymbol, Symbols.TypeSymbol)"/>
/// via the slice-to-interface arm (originally landed for issue #570). The
/// substitution path in <c>Binder.SubstituteType</c> rebuilds an
/// <c>IEnumerable[T]</c> parameter into a closed CLR
/// <see cref="System.Collections.Generic.IEnumerable{T}"/> at the call site,
/// so the slice-to-interface classifier sees the correctly-shaped target
/// and admits the implicit, no-op conversion. These tests pin that
/// behaviour at all the argument slots the issue body enumerates.
/// </remarks>
public class Issue821SliceToInterfaceAtArgumentSlotBindingTests
{
    [Fact]
    public void IssueRepro_StaticGenericIndexed_IEnumerableOfT_FromSliceOfT_Binds()
    {
        // The literal repro from the issue body: `Sequences.Indexed[int32](ints)`
        // where `ints` is a `[]int32` slice and the parameter is `IEnumerable[T]`.
        const string source = @"
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
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StaticMethodArgSlot_SliceOfInt_To_IEnumerableOfInt_Binds()
    {
        // Non-generic shared method taking `IEnumerable[int32]` directly.
        // The argument is a `[]int32` slice literal.
        const string source = @"
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take(source IEnumerable[int32]) int32 { return 0 }
    }
}

let _ = Sink.Take([]int32{1, 2, 3})
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void FreeFunctionArgSlot_SliceOfString_To_IEnumerableOfString_Binds()
    {
        // Free-function call slot: `[]string` argument flows into a
        // top-level function parameter typed as `IEnumerable[string]`.
        const string source = @"
package P
import System.Collections.Generic

func Take(source IEnumerable[string]) int32 { return 0 }

let _ = Take([]string{""a"", ""b""})
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void FreeFunctionArgSlot_GenericIndexed_SliceOfInt_To_IEnumerableOfT_Binds()
    {
        // Free-function generic method with an `IEnumerable[T]` parameter
        // — confirms the substitution path (`Binder.SubstituteType`)
        // rebuilds the closed `IEnumerable<int32>` before classification.
        const string source = @"
package P
import System.Collections.Generic

func Indexed[T](source IEnumerable[T]) int32 { return 0 }

let _ = Indexed[int32]([]int32{10, 20, 30})
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StaticMethodArgSlot_SliceOfInt_To_IListOfInt_Binds()
    {
        // `IList[T]` is implemented by `T[]` — slice must convert.
        const string source = @"
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IList[T]) int32 { return source.Count }
    }
}

let _ = Sink.Take[int32]([]int32{1, 2, 3})
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StaticMethodArgSlot_SliceOfInt_To_ICollectionOfInt_Binds()
    {
        // `ICollection[T]` is implemented by `T[]` — slice must convert.
        const string source = @"
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source ICollection[T]) int32 { return source.Count }
    }
}

let _ = Sink.Take[int32]([]int32{1, 2, 3})
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StaticMethodArgSlot_SliceOfInt_To_IReadOnlyListOfInt_Binds()
    {
        // `IReadOnlyList[T]` is implemented by `T[]` — slice must convert.
        const string source = @"
package P
import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IReadOnlyList[T]) int32 { return source.Count }
    }
}

let _ = Sink.Take[int32]([]int32{1, 2, 3})
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Negative_SliceOfInt_To_IEnumerableOfString_Rejected()
    {
        // G# slices are invariant: `[]int32` must NOT convert to
        // `IEnumerable[string]`. The binder rejects with GS0154
        // ("Parameter requires …") — the standard overload-resolution
        // argument-type mismatch diagnostic.
        const string source = @"
package P
import System.Collections.Generic

func Take(source IEnumerable[string]) int32 { return 0 }

let _ = Take([]int32{1, 2, 3})
";
        var diags = GetDiagnostics(source);
        Assert.NotEmpty(diags);
        Assert.Contains(diags, d => d.Id == "GS0154" || d.Id == "GS0155");
    }

    [Fact]
    public void SliceOfString_ToCovariantIEnumerableOfObject_Accepted()
    {
        const string source = @"
package P
import System.Collections.Generic

func Take(source IEnumerable[object]) int32 { return 0 }

let _ = Take([]string{""a"", ""b""})
";
        var diags = GetDiagnostics(source);
        Assert.Empty(diags);
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
    /// against a <see cref="ImmutableArray{T}"/> without exposing the
    /// GSharp diagnostic surface to xUnit's enumerable inference.
    /// </summary>
    private readonly struct ImmutableArrayOfDiagnostic : IReadOnlyCollection<Diagnostic>
    {
        private readonly ImmutableArray<Diagnostic> diagnostics;

        public ImmutableArrayOfDiagnostic(ImmutableArray<Diagnostic> diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public int Count => this.diagnostics.Length;

        public IEnumerator<Diagnostic> GetEnumerator()
        {
            foreach (var diagnostic in this.diagnostics)
            {
                yield return diagnostic;
            }
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }
}
