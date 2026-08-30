// <copyright file="Issue3685CovariantArrayUpcastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3685 (the <c>InternalAnalyzers.Tests</c> self-migration wall): G#
/// slices are INVARIANT for implicit conversions by design (issue #2516), so a
/// migrated C# array-covariance conversion — <c>PortableExecutableReference[]</c>
/// flowing into a <c>MetadataReference[]</c> return — had no spelling at all:
/// the bare value was <c>GS0155</c> and the explicit <c>cast[[]Base](derived)</c>
/// was rejected too, because the array arms of <c>Conversion.ClassifyCore</c>
/// only offered <c>HasCheckedReferenceConversion</c> (a DOWNcast predicate) as
/// their explicit fallback. The covariant UPcast is now explicit-only: still no
/// implicit conversion (the <see cref="System.ArrayTypeMismatchException"/>
/// hazard stays announced), but <c>cast[[]Base](derived)</c> binds and emits as
/// the reference-level no-op it is — a G# slice IS a CLR SZ-array (ADR-0016),
/// which the CLR already treats as a <c>Base[]</c>.
/// </summary>
public class Issue3685CovariantArrayUpcastTests
{
    [Fact]
    public void ExplicitCovariantSliceUpcast_PreservesTheSameArrayInstance()
    {
        // Executing witness: the upcast must be a reference-level no-op, not a
        // projecting copy — `ReferenceEquals` discriminates the two, and the
        // element read through the widened static type proves the emitted body
        // is well-formed. Pre-fix this failed to bind (GS0155/GS0156).
        var result = EmittedOracle.Evaluate(@"
import System
import System.IO
let dirs = []DirectoryInfo{ DirectoryInfo(""alpha""), DirectoryInfo(""beta"") }
let widened = cast[[]FileSystemInfo](dirs)
widened[1].Name + "":"" + Object.ReferenceEquals(dirs, widened).ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("beta:True", result.Value);
    }

    [Fact]
    public void ExplicitCovariantUpcastOfAnImportedArray_Binds()
    {
        // The wall's exact shape: `Enumerable.ToArray()` surfaces the derived
        // element as an imported SZ-array (`DirectoryInfo[]`, not `[]…`), which
        // is the OTHER array arm of ClassifyCore — it needed the same fallback.
        var result = EmittedOracle.Evaluate(@"
import System.IO
import System.Linq
let widened = cast[[]FileSystemInfo]([]string{ ""gamma"" }.Select((n string) -> DirectoryInfo(n)).ToArray())
widened[0].Name
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("gamma", result.Value);
    }

    [Fact]
    public void BareCovariantSliceValue_StillRequiresTheCast()
    {
        // The invariance decision (#2516) is unchanged: only the SPELLING gained
        // a target. An unannounced covariant assignment stays an error — now
        // GS0156 ("an explicit conversion exists"), which points at the cast,
        // rather than the dead-end GS0155.
        var result = EmittedOracle.Evaluate(@"
import System.IO
func Widen(dirs []DirectoryInfo) []FileSystemInfo {
    return dirs
}
0
");
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0156");
    }

    [Fact]
    public void UnrelatedElementTypes_AreStillRejected()
    {
        // The new arm requires an IMPLICIT element conversion, so it widens the
        // explicit surface only where the CLR array relationship actually holds.
        // Unrelated reference elements have no such relationship and must stay
        // an error rather than becoming a cast that throws at runtime.
        var result = EmittedOracle.Evaluate(@"
import System.IO
func Reinterpret(dirs []DirectoryInfo) []string {
    return cast[[]string](dirs)
}
0
");
        Assert.NotEmpty(result.Diagnostics);
    }
}
