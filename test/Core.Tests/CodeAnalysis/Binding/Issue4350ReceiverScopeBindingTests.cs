// <copyright file="Issue4350ReceiverScopeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0187 / issue #4350: three binder gaps the <c>Gsharp.Runtime.Values</c>
/// self-migration exposed —
/// the C# scoped-<c>this</c> rule for ref-returning calls on a struct
/// receiver, generic operator owners spelled through a nullable receiver
/// clause, and construction syntax colliding with same-named extension
/// functions.
/// </summary>
public class Issue4350ReceiverScopeBindingTests
{
    private const string SliceLike = """
        package P
        struct Inner {
            let items []int32
            init(items []int32) { this.items = items }
            prop this[i int32] ref int32 {
                get { return ref items[i] }
            }
            func At(i int32) ref int32 { return ref items[i] }
        }
        """;

    [Fact]
    public void RefReadOnlyIndexerForwardThroughStructField_IsClean()
    {
        // ReadOnlySlice's `ref readonly T this[int i] => ref slice[i];`.
        var diagnostics = Bind(SliceLike + """

            struct Outer {
                let inner Inner
                init(inner Inner) { this.inner = inner }
                prop this[i int32] ref readonly int32 -> inner[i]
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void WritableRefForwardThroughReadOnlyField_IsClean()
    {
        // The callee cannot return into its (copied) receiver, so the
        // reference it hands back stays writable, as in C#.
        var diagnostics = Bind(SliceLike + """

            struct Outer {
                let inner Inner
                init(inner Inner) { this.inner = inner }
                func At(i int32) ref int32 { return ref inner.At(i) }
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ByValueParameterReceiver_NonUnscopedRefMember_IsClean()
    {
        var diagnostics = Bind(SliceLike + """

            func forward(inner Inner, i int32) ref int32 { return ref inner[i] }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void LocalReceiver_UnscopedRefMember_StillReportsGS0254()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            struct Acc {
                var Total int32

                @UnscopedRef
                func Slot() ref int32 { return ref this.Total }
            }
            func fromLocal() ref int32 {
                var a = Acc{Total: 1}
                return ref a.Slot()
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void ScopedRefStructReceiver_ReferentStillCannotEscape()
    {
        // The receiver's REF scope no longer matters, but a ref struct's
        // VALUE scope still does, exactly as in C#: a `scoped` ref struct
        // receiver cannot hand a reference out of the function.
        var diagnostics = Bind("""
            package P
            ref struct Holder {
                var Arr []int32
                func At(i int32) ref int32 { return ref Arr[i] }
            }
            func ok(h Holder) ref int32 { return ref h.At(0) }
            func bad(scoped h Holder) ref int32 { return ref h.At(0) }
            """);
        var errors = diagnostics.Where(d => d.IsError).ToArray();
        var error = Assert.Single(errors);
        Assert.Contains("bad", SourceLine(error));
    }

    [Fact]
    public void NullableGenericReceiverOperators_BindAgainstOwnerTypeParameters()
    {
        var result = EmittedOracle.Evaluate("""
            open class Box[T] {
                var V T
                init(v T) { V = v }
            }
            func (left Box[T]?) operator ==(right Box[T]?) bool -> object.ReferenceEquals(left, right)
            func (left Box[T]?) operator !=(right Box[T]?) bool -> !(left == right)
            let a = Box[int32](1)
            let b Box[int32]? = nil
            (a == a) && (a != b) && !(a == b)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void Construction_PrefersTypeOverSameNamedExtensionFunction()
    {
        var result = EmittedOracle.Evaluate("""
            struct Pair[T] {
                let A T
                let B int32
                init(a T, b int32, c int32, d int32) {
                    A = a
                    B = b + c + d
                }
                func Make() Pair[T] -> Pair[T](A, 1, 2, 3)
            }
            func (p Pair[T]) Pair[T](x int32, y int32, z int32) Pair[T] -> Pair[T](p.A, x, y, z)
            let p = Pair[int32](5, 1, 1, 1)
            p.B * 10000 + p.Make().B * 100 + p.Pair(7, 8, 9).B
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal((3 * 10000) + (6 * 100) + 24, result.Value);
    }

    [Fact]
    public void Construction_FreeFunctionOfTheSameName_StillWins()
    {
        // Issue #2403 is unchanged: a free (non-extension) function shadows a
        // same-named type in call position.
        var result = EmittedOracle.Evaluate("""
            struct Point {
                let X int32
                init(x int32) { X = x }
            }
            func Point(x int32) int32 -> x * 2
            Point(21)
            """);
        Assert.Equal(42, result.Value);
    }

    private static string SourceLine(Diagnostic diagnostic)
    {
        var text = diagnostic.Location.Text!;
        var line = text.Lines[diagnostic.Location.StartLine];
        return text.ToString(line.Span);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        return compilation.GlobalScope.Diagnostics.AddRange(compilation.BoundProgram.Diagnostics);
    }
}
