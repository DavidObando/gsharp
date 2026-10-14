// <copyright file="Issue1189FilenameCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import Xunit

/// Issue #1189: emitted `.gs` file names must be unique within a run. Two C#
/// sources that share a base name in different folders (e.g. `Types/Enums.cs`
/// and `Diagnostics/Enums.cs`) previously both mapped to `Enums.gs`, so
/// the second silently overwrote the first — losing the translated code and
/// producing spurious downstream `GS0113 Type '…' doesn't exist` diagnostics.
open class Issue1189FilenameCollisionTests {
    @Fact
    func DistinctBaseNames_AreUnchanged() {
        let used = NewUsedSet()
        let a = EmittedFileNaming.UniqueGsFileName("/proj/Foo.cs", used)
        let b = EmittedFileNaming.UniqueGsFileName("/proj/Bar.cs", used)
        Assert.Equal("Foo.gs", a)
        Assert.Equal("Bar.gs", b)
    }

    @Fact
    func CollidingBaseNames_AreDisambiguatedByDirectory() {
        let used = NewUsedSet()
        let first = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used)
        let second = EmittedFileNaming.UniqueGsFileName("/proj/Diagnostics/Enums.cs", used)
        Assert.Equal("Enums.gs", first)
        Assert.Equal("Diagnostics.Enums.gs", second)
        Assert.NotEqual(first, second)
    }

    @Fact
    func CollisionsAreCaseInsensitive() {
        let used = NewUsedSet()
        let first = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used)
        let second = EmittedFileNaming.UniqueGsFileName("/proj/other/enums.cs", used)
        // The base names differ only by case but must still not collide on a
        // case-insensitive filesystem.
        Assert.NotEqual(first.ToLowerInvariant(), second.ToLowerInvariant())
    }

    @Fact
    func RepeatedDirectoryAndBase_FallsBackToCounter() {
        let used = NewUsedSet()
        // Three sources that share both the immediate directory name and base name
        // (different roots). The first keeps the plain name, the second gains the
        // directory prefix, and subsequent ones add more path and/or a counter.
        let a = EmittedFileNaming.UniqueGsFileName("/a/Shared/Enums.cs", used)
        let b = EmittedFileNaming.UniqueGsFileName("/b/Shared/Enums.cs", used)
        let c = EmittedFileNaming.UniqueGsFileName("/c/Shared/Enums.cs", used)
        let names = HashSet[string]([]string{a, b, c}, StringComparer.OrdinalIgnoreCase)
        Assert.Equal(3, names.Count)
        Assert.Equal("Enums.gs", a)
    }

    @Fact
    func IsDeterministic() {
        let Run = func () string {
            let used = NewUsedSet()
            let x = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used)
            let y = EmittedFileNaming.UniqueGsFileName("/proj/Diagnostics/Enums.cs", used)
            return x + "|" + y
        }
        Assert.Equal(Run(), Run())
    }

    @Fact
    func AllReturnedNames_AreRegisteredInTheSet() {
        let used = NewUsedSet()
        let a = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used)
        let b = EmittedFileNaming.UniqueGsFileName("/proj/Diagnostics/Enums.cs", used)
        Assert.Contains(a, used)
        Assert.Contains(b, used)
    }

    shared {
        private func NewUsedSet() HashSet[string] -> HashSet[string](StringComparer.OrdinalIgnoreCase)
    }
}
