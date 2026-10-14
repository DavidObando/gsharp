// <copyright file="Issue3685CovariantArrayUpcastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3685 (the `InternalAnalyzers.Tests` self-migration wall): G#
/// slices are INVARIANT for implicit conversions by design (issue #2516), so a
/// migrated C# array-covariance conversion — `PortableExecutableReference[]`
/// flowing into a `MetadataReference[]` return — had no spelling at all:
/// the bare value was `GS0155` and the explicit `cast[[]Base](derived)`
/// was rejected too, because the array arms of `Conversion.ClassifyCore`
/// only offered `HasCheckedReferenceConversion` (a DOWNcast predicate) as
/// their explicit fallback. The covariant UPcast is now explicit-only: still no
/// implicit conversion (the (cref:System.ArrayTypeMismatchException)
/// hazard stays announced), but `cast[[]Base](derived)` binds and emits as
/// the reference-level no-op it is — a G# slice IS a CLR SZ-array (ADR-0016),
/// which the CLR already treats as a `Base[]`.
open class Issue3685CovariantArrayUpcastTests {
    @Fact
    func ExplicitCovariantSliceUpcast_PreservesTheSameArrayInstance() {
        // Executing witness: the upcast must be a reference-level no-op, not a
        // projecting copy — `ReferenceEquals` discriminates the two, and the
        // element read through the widened static type proves the emitted body
        // is well-formed. Pre-fix this failed to bind (GS0155/GS0156).
        let result = EmittedOracle.Evaluate(`
import System
import System.IO
let dirs = []DirectoryInfo{ DirectoryInfo("alpha"), DirectoryInfo("beta") }
let widened = cast[[]FileSystemInfo](dirs)
widened[1].Name + ":" + Object.ReferenceEquals(dirs, widened).ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("beta:True", result.Value)
    }

    @Fact
    func ExplicitCovariantUpcastOfAnImportedArray_Binds() {
        // The wall's exact shape: `Enumerable.ToArray()` surfaces the derived
        // element as an imported SZ-array (`DirectoryInfo[]`, not `[]…`), which
        // is the OTHER array arm of ClassifyCore — it needed the same fallback.
        let result = EmittedOracle.Evaluate(`
import System.IO
import System.Linq
let widened = cast[[]FileSystemInfo]([]string{ "gamma" }.Select((n string) -> DirectoryInfo(n)).ToArray())
widened[0].Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("gamma", result.Value)
    }

    @Fact
    func BareCovariantSliceValue_StillRequiresTheCast() {
        // The invariance decision (#2516) is unchanged: only the SPELLING gained
        // a target. An unannounced covariant assignment stays an error — now
        // GS0156 ("an explicit conversion exists"), which points at the cast,
        // rather than the dead-end GS0155.
        let result = EmittedOracle.Evaluate(`
import System.IO
func Widen(dirs []DirectoryInfo) []FileSystemInfo {
    return dirs
}
0
`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0156")
    }

    @Fact
    func CovariantUpcast_StoringAWrongElement_ThrowsArrayTypeMismatchException() {
        // Issue #3858: the covariant upcast is UNSOUND BY DESIGN, exactly as in
        // C# — the widened static type admits a store the runtime array rejects,
        // and the CLR throws ArrayTypeMismatchException. That hazard is why the
        // conversion stays explicit-only (#2516); this is the executing witness
        // that `cast[[]Base](derived)` preserves the CLR's element check rather
        // than quietly producing a `Base[]` that would accept anything.
        let result = EmittedOracle.Evaluate(`
import System
import System.IO
let dirs = []DirectoryInfo{ DirectoryInfo("alpha") }
let widened = cast[[]FileSystemInfo](dirs)
var caught = "none"
try {
    widened[0] = FileInfo("beta")
} catch (e ArrayTypeMismatchException) {
    caught = "ArrayTypeMismatchException"
}
caught
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ArrayTypeMismatchException", result.Value)
    }

    @Fact
    func ValueElementUpcast_IsStillRejected() {
        // Anti-vacuity: C# array covariance is REFERENCE-element-only. `int[]`
        // does NOT convert to `object[]` in C# — implicitly or explicitly — and
        // the CLR has no such array relationship (the elements are 4-byte
        // integers, not references), so `[]int32 -> []object` must stay an
        // error rather than becoming a cast that corrupts memory.
        let result = EmittedOracle.Evaluate(`
func Widen(values []int32) []object {
    return cast[[]object](values)
}
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func UnrelatedElementTypes_AreStillRejected() {
        // The new arm requires an IMPLICIT element conversion, so it widens the
        // explicit surface only where the CLR array relationship actually holds.
        // Unrelated reference elements have no such relationship and must stay
        // an error rather than becoming a cast that throws at runtime.
        let result = EmittedOracle.Evaluate(`
import System.IO
func Reinterpret(dirs []DirectoryInfo) []string {
    return cast[[]string](dirs)
}
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }
}
