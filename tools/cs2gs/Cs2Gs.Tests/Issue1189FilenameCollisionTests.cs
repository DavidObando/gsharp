// <copyright file="Issue1189FilenameCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1189: emitted <c>.gs</c> file names must be unique within a run. Two C#
/// sources that share a base name in different folders (e.g. <c>Types/Enums.cs</c>
/// and <c>Diagnostics/Enums.cs</c>) previously both mapped to <c>Enums.gs</c>, so
/// the second silently overwrote the first — losing the translated code and
/// producing spurious downstream <c>GS0113 Type '…' doesn't exist</c> diagnostics.
/// </summary>
public class Issue1189FilenameCollisionTests
{
    private static HashSet<string> NewUsedSet() =>
        new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    [Fact]
    public void DistinctBaseNames_AreUnchanged()
    {
        HashSet<string> used = NewUsedSet();

        string a = EmittedFileNaming.UniqueGsFileName("/proj/Foo.cs", used);
        string b = EmittedFileNaming.UniqueGsFileName("/proj/Bar.cs", used);

        Assert.Equal("Foo.gs", a);
        Assert.Equal("Bar.gs", b);
    }

    [Fact]
    public void CollidingBaseNames_AreDisambiguatedByDirectory()
    {
        HashSet<string> used = NewUsedSet();

        string first = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used);
        string second = EmittedFileNaming.UniqueGsFileName("/proj/Diagnostics/Enums.cs", used);

        Assert.Equal("Enums.gs", first);
        Assert.Equal("Diagnostics.Enums.gs", second);
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void CollisionsAreCaseInsensitive()
    {
        HashSet<string> used = NewUsedSet();

        string first = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used);
        string second = EmittedFileNaming.UniqueGsFileName("/proj/other/enums.cs", used);

        // The base names differ only by case but must still not collide on a
        // case-insensitive filesystem.
        Assert.NotEqual(
            first.ToLowerInvariant(),
            second.ToLowerInvariant());
    }

    [Fact]
    public void RepeatedDirectoryAndBase_FallsBackToCounter()
    {
        HashSet<string> used = NewUsedSet();

        // Three sources that share both the immediate directory name and base name
        // (different roots). The first keeps the plain name, the second gains the
        // directory prefix, and subsequent ones add more path and/or a counter.
        string a = EmittedFileNaming.UniqueGsFileName("/a/Shared/Enums.cs", used);
        string b = EmittedFileNaming.UniqueGsFileName("/b/Shared/Enums.cs", used);
        string c = EmittedFileNaming.UniqueGsFileName("/c/Shared/Enums.cs", used);

        var names = new HashSet<string>(new[] { a, b, c }, StringComparer.OrdinalIgnoreCase);
        Assert.Equal(3, names.Count);
        Assert.Equal("Enums.gs", a);
    }

    [Fact]
    public void IsDeterministic()
    {
        string Run()
        {
            HashSet<string> used = NewUsedSet();
            string x = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used);
            string y = EmittedFileNaming.UniqueGsFileName("/proj/Diagnostics/Enums.cs", used);
            return x + "|" + y;
        }

        Assert.Equal(Run(), Run());
    }

    [Fact]
    public void AllReturnedNames_AreRegisteredInTheSet()
    {
        HashSet<string> used = NewUsedSet();

        string a = EmittedFileNaming.UniqueGsFileName("/proj/Types/Enums.cs", used);
        string b = EmittedFileNaming.UniqueGsFileName("/proj/Diagnostics/Enums.cs", used);

        Assert.Contains(a, used);
        Assert.Contains(b, used);
    }
}
