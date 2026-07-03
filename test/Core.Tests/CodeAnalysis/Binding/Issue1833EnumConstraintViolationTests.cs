// <copyright file="Issue1833EnumConstraintViolationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1833 (follow-up review note on PR #1832 / #1601): a type argument
/// that is <c>struct</c>-constrained but <b>not</b> <c>Enum</c>-constrained — a
/// concrete non-enum user struct, or a bare <c>[T struct]</c> type parameter —
/// passed to a method whose type parameter carries a real <c>System.Enum</c>
/// base-class constraint (e.g. <c>Enum.IsDefined&lt;TEnum&gt;</c> — <b>not</b>
/// <c>Enum.TryParse</c>, whose real BCL signature only constrains
/// <c>TEnum : struct</c> with no <c>Enum</c> base bound at all) must be
/// rejected at bind time with a clear <c>GS0152</c> constraint-violation
/// diagnostic instead of silently binding through overload resolution and
/// only failing later at CLR verification.
/// <para>
/// Root cause: <c>OverloadResolution.SatisfiesGenericConstraints</c>'s
/// base-type-constraint loop treated <em>every</em> <c>System.ValueType</c>-
/// or <c>System.Enum</c>-named constraint as satisfied once the argument was
/// classified as a value-type-erased symbol (<c>IsValueTypeErasedSymbol</c>,
/// added by #1601). That is correct for <c>ValueType</c> (any struct/enum
/// satisfies it) but wrong for <c>Enum</c> — a plain struct, or a struct-only
/// type parameter, does not derive from <c>System.Enum</c>. The fix walks the
/// recovered symbol's real derivation/constraint chain
/// (<c>ValueTypeErasedSymbolSatisfiesBaseConstraint</c>) so only an actual enum
/// (or a type parameter that itself carries an <c>Enum</c> bound) satisfies the
/// <c>Enum</c> constraint, while <c>ValueType</c>/<c>Object</c> remain
/// trivially satisfied by any value type.
/// </para>
/// </summary>
public class Issue1833EnumConstraintViolationTests
{
    [Fact]
    public void ConcreteNonEnumStruct_EnumIsDefined_ReportsConstraintViolation_NotCrash()
    {
        // (a) A concrete user struct (not an enum) explicitly supplied as
        // Enum.IsDefined's type argument must be rejected at bind time with
        // the GS0152 constraint-violation diagnostic — not silently bound
        // (which would only fail later at CLR verification/emit).
        const string source = @"
package p
import System

struct Point {
    var X int32
    var Y int32
}

var pt = Point(1, 2)
var ok = Enum.IsDefined[Point](pt)
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0152");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void StructOnlyTypeParameter_ForwardedToEnumIsDefined_ReportsConstraintViolation()
    {
        // (b) A bare `[T struct]` type parameter (struct-constrained but NOT
        // Enum-constrained) forwarded to Enum.IsDefined[T] must also be
        // rejected at bind time with GS0152 — it is indistinguishable from an
        // arbitrary non-enum struct from Enum.IsDefined's point of view.
        const string source = @"
package p
import System

func Check[T struct](v T) bool {
    return Enum.IsDefined[T](v)
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0152");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void EnumConstrainedTypeParameter_EnumIsDefined_DoesNotFalsePositive()
    {
        // Negative control mirroring (a)/(b): an in-scope type parameter that
        // itself genuinely carries the `Enum` bound (`[TEnum Enum struct]`)
        // must NOT trip the new GS0152 constraint-violation diagnostic when
        // forwarded to Enum.IsDefined[TEnum] — `ValueTypeErasedSymbolSatisfies
        // BaseConstraint` must recognize its `ClassConstraint` as the real
        // `System.Enum` bound. (Whether the call resolves end-to-end is
        // unaffected by this fix either way — see the dedicated Enum.TryParse
        // regression test below for the full round-trip guard.)
        const string source = @"
package p
import System

func Check[TEnum Enum struct](v TEnum) bool {
    return Enum.IsDefined[TEnum](v)
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void ConcreteEnum_EnumTryParse_StillBinds_Issue1601Regression()
    {
        // (c) Regression guard for the exact #1601 repro shape:
        // Enum.TryParse[TEnum] with TEnum: Enum, struct forwarded, and the
        // concrete same-compilation enum control — Enum.TryParse's real BCL
        // constraint is only `struct` (no `Enum` base), so this must be
        // completely unaffected by the new base-constraint enforcement.
        const string source = @"
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum? {
    if !Enum.TryParse[TEnum](arg, out var result) {
        return nil
    }
    return result
}

enum Color { Red, Green }

var ok = Enum.TryParse[Color](""Red"", out var concrete)
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0152");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void StructOnlyTypeParameter_MemoryMarshalCast_StillBinds_GeneralizationPositiveCase()
    {
        // (d) Generalization positive control: the SAME bare `[T struct]` type
        // parameter that must be REJECTED against Enum.IsDefined's `Enum` bound
        // (test (b) above) must still be ACCEPTED against a method whose only
        // base-type constraint is the implicit `ValueType` one (MemoryMarshal
        // .Cast's `where TFrom : struct, TTo : struct`) — proving the fix
        // enforces the ACTUAL constraint instead of blanket-rejecting every
        // value-type-erased argument.
        const string source = @"
package p
import System.Runtime.InteropServices

func Cast[T struct](s Span[T]) Span[uint8] {
    return MemoryMarshal.Cast[T, uint8](s)
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0152");
        Assert.Empty(diagnostics);
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics.ToList();
    }
}
