// <copyright file="CorePublicApiAllowanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.PublicApi;

/// <summary>
/// ADR-0199 / #4654: the Core public-API snapshot tolerates exactly the listed
/// record <c>Deconstruct</c> additions and nothing else. Each test pairs the
/// allowance with the real golden comparison, so a wider allowance (or a
/// removed one) flips an assertion here.
/// </summary>
public sealed class CorePublicApiAllowanceTests : IDisposable
{
    private const string Record = "Demo.Pair";
    private const string Deconstruct = "  method public Void Deconstruct(out Int32 A, out Int32 B)";

    private readonly string directory = Path.Combine(Path.GetTempPath(), "adr0199-" + Guid.NewGuid().ToString("N"));

    public CorePublicApiAllowanceTests()
    {
        Directory.CreateDirectory(this.directory);
    }

    public void Dispose()
    {
        Directory.Delete(this.directory, recursive: true);
    }

    [Fact]
    public void ListedDeconstructOnRecord_IsRemovedAndReported()
    {
        string[] golden = NativeSurface();
        string[] migrated = WithMember(golden, Deconstruct);

        var result = CorePublicApiAllowance.Apply(migrated, Allow(Record, Deconstruct));

        Assert.Equal(golden, result.Lines);
        Assert.Equal(new[] { Record + " | method public Void Deconstruct(out Int32 A, out Int32 B)" }, result.Present);
        Assert.True(Compare(golden, result.Lines).IsMatch);
    }

    [Fact]
    public void NativeSurface_PassesWithoutTheAllowedEntries()
    {
        string[] golden = NativeSurface();

        var result = CorePublicApiAllowance.Apply(golden, Allow(Record, Deconstruct));

        Assert.Empty(result.Present);
        Assert.True(Compare(golden, result.Lines).IsMatch);
    }

    [Fact]
    public void UnlistedDeconstructOnRecord_StillFails()
    {
        string[] golden = NativeSurface();
        string[] migrated = WithMember(golden, "  method public Void Deconstruct(out Int32 A)");

        var result = CorePublicApiAllowance.Apply(migrated, Allow(Record, Deconstruct));

        Assert.Empty(result.Present);
        Assert.False(Compare(golden, result.Lines).IsMatch);
    }

    [Fact]
    public void ListedDeconstructOnOtherRecord_StillFails()
    {
        string[] golden = NativeSurface();
        string[] migrated = WithMember(golden, Deconstruct, "Demo.Other");

        var result = CorePublicApiAllowance.Apply(migrated, Allow(Record, Deconstruct));

        Assert.False(Compare(golden, result.Lines).IsMatch);
    }

    [Fact]
    public void NonSynthesizedMemberOnRecord_StillFails()
    {
        string[] golden = NativeSurface();
        string[] migrated = WithMember(golden, "  method public Void Reset()");

        var result = CorePublicApiAllowance.Apply(migrated, Allow(Record, Deconstruct));

        Assert.False(Compare(golden, result.Lines).IsMatch);
    }

    [Fact]
    public void NonDeconstructAllowanceEntry_IsRejected()
    {
        string[] migrated = WithMember(NativeSurface(), "  method public Void Reset()");

        Assert.Throws<InvalidOperationException>(
            () => CorePublicApiAllowance.Apply(migrated, Allow(Record, "  method public Void Reset()")));
    }

    [Fact]
    public void ListedDeconstructOnNonRecord_IsRejected()
    {
        string[] migrated = WithMember(NativeSurface(), Deconstruct, "Demo.Plain");

        Assert.Throws<InvalidOperationException>(
            () => CorePublicApiAllowance.Apply(migrated, Allow("Demo.Plain", Deconstruct)));
    }

    [Fact]
    public void RemovedExistingMember_StillFails()
    {
        string[] golden = NativeSurface();
        string[] migrated = golden.Where(line => !line.Contains("get_B", StringComparison.Ordinal)).ToArray();

        var result = CorePublicApiAllowance.Apply(migrated, Allow(Record, Deconstruct));

        Assert.False(Compare(golden, result.Lines).IsMatch);
    }

    [Fact]
    public void ShippedAllowance_ListsExactlyTheTenAdr0199RecordTypes()
    {
        string path = Path.Combine(
            CorePublicApiSnapshotTests.LocateRepoRoot(), "test", "Core.Tests", "Baselines", CorePublicApiAllowance.AllowanceFileName);
        var entries = CorePublicApiAllowance.Parse(File.ReadAllText(path));

        string[] expected =
        {
            "GSharp.Core.CodeAnalysis.Binding.BoundAttributeArgument",
            "GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator",
            "GSharp.Core.CodeAnalysis.Binding.BoundCatchClause",
            "GSharp.Core.CodeAnalysis.Binding.BoundFieldInitializer",
            "GSharp.Core.CodeAnalysis.Binding.BoundMapEntry",
            "GSharp.Core.CodeAnalysis.Binding.BoundSelectCase",
            "GSharp.Core.CodeAnalysis.Binding.BoundUnaryOperator",
            "GSharp.Core.CodeAnalysis.Symbols.MarshalAsMetadata",
            "GSharp.Core.CodeAnalysis.Symbols.PInvokeMetadata",
            "GSharp.Core.CodeAnalysis.Symbols.StructLayoutMetadata",
        };
        Assert.Equal(expected, entries.Select(e => e.TypeName).OrderBy(n => n, StringComparer.Ordinal).ToArray());
        Assert.All(
            entries,
            e => Assert.StartsWith("  method public Void Deconstruct(", e.MemberLine, StringComparison.Ordinal));
    }

    private static string[] NativeSurface() => new[]
    {
        "type sealed class Demo.Other : System.Object",
        "  method public Demo.Other <Clone>$()",
        "type sealed class Demo.Pair : System.Object",
        "  method public Demo.Pair <Clone>$()",
        "  method public Int32 get_A()",
        "  method public Int32 get_B()",
        "type sealed class Demo.Plain : System.Object",
        "  method public Int32 get_A()",
    };

    private static IReadOnlyList<CorePublicApiAllowance.Entry> Allow(string type, string memberLine) =>
        new[] { new CorePublicApiAllowance.Entry(type, memberLine) };

    private static string[] WithMember(string[] lines, string member, string type = Record)
    {
        var result = new List<string>(lines);
        int header = result.FindIndex(line => line.StartsWith("type ", StringComparison.Ordinal)
            && line.Contains(" " + type + " ", StringComparison.Ordinal));
        result.Insert(header + 1, member);
        return result.ToArray();
    }

    private GoldenFileComparison Compare(IReadOnlyList<string> golden, IReadOnlyList<string> actual)
    {
        string path = Path.Combine(this.directory, "golden.txt");
        File.WriteAllText(path, string.Join("\n", golden) + "\n");
        return GoldenFile.CompareFile(path, string.Join("\n", actual) + "\n", update: false);
    }
}
