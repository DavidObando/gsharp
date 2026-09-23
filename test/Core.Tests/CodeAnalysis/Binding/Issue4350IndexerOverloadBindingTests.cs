// <copyright file="Issue4350IndexerOverloadBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0187 / issue #4350: a type may declare several indexers that differ by
/// index-parameter signature, and an index access selects one by ordinary
/// overload resolution, exactly like C#.
/// </summary>
public class Issue4350IndexerOverloadBindingTests
{
    private const string Table = """
        class Table {
            private var values []string = []string{"a", "b", "c"}
            prop this[index int32] string {
                get { return values[index] }
                set { values[index] = value }
            }
            prop this[name string] string {
                get { return name + "!" }
            }
            prop this[row int32, column int32] int32 -> row * 10 + column
        }
        """;

    [Fact]
    public void OverloadsDifferingByParameterType_AreDeclaredAndSelected()
    {
        var result = EmittedOracle.Evaluate(Table + "\nlet t = Table()\nt[1] + t[\"k\"]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("bk!", result.Value);
    }

    [Fact]
    public void OverloadsDifferingByArity_AreSelectedByIndexCount()
    {
        var result = EmittedOracle.Evaluate(Table + "\nlet t = Table()\nt[2, 3]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(23, result.Value);
    }

    [Fact]
    public void SetterOverload_IsSelectedForWrites()
    {
        var result = EmittedOracle.Evaluate(Table + "\nlet t = Table()\nt[0] = \"z\"\nt[0]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("z", result.Value);
    }

    [Fact]
    public void WriteToGetterOnlyOverload_IsRejected()
    {
        var result = EmittedOracle.Evaluate(Table + "\nlet t = Table()\nt[\"k\"] = \"z\"");
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void BetterConversion_WinsOverWorseConversion()
    {
        var result = EmittedOracle.Evaluate("""
            class Pick {
                prop this[value int64] string -> "int64"
                prop this[value float64] string -> "float64"
            }
            Pick()[1]
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("int64", result.Value);
    }

    [Fact]
    public void GenericStruct_RefReturningOverloads_UseReceiverSubstitution()
    {
        var result = EmittedOracle.Evaluate("""
            struct Buffer[T](items []T) {
                prop this[index int32] ref T -> items[index]
                prop this[index System.Index] ref T -> items[index.GetOffset(items.Length)]
                prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]
            }
            var b = Buffer[int32]([]int32{10, 20, 30})
            b[0] = 5
            b[^1] = 7
            b[0] + b[^2] + b[1, true] + b[2]
            """);
        Assert.Empty(result.Diagnostics);
        // {10, 20, 30} -> {5, 20, 7}: b[0] + b[^2] + b[1, fromEnd] + b[2].
        Assert.Equal(5 + 20 + 7 + 7, result.Value);
    }

    [Fact]
    public void InterfaceOverloads_DispatchThroughTheInterface()
    {
        var result = EmittedOracle.Evaluate("""
            interface ILookup {
                prop this[index int32] string { get; }
                prop this[key string] string { get; }
            }
            class Lookup : ILookup {
                prop this[index int32] string -> "i" + index.ToString()
                prop this[key string] string -> "k" + key
            }
            let l ILookup = Lookup()
            l[4] + l["x"]
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("i4kx", result.Value);
    }

    [Fact]
    public void DerivedIndexer_HidesOnlyTheSameSignature()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base {
                open prop this[index int32] string -> "base-int"
                prop this[key string] string -> "base-string"
            }
            class Derived : Base {
                override prop this[index int32] string -> "derived-int"
            }
            let d = Derived()
            d[0] + "," + d["k"]
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("derived-int,base-string", result.Value);
    }

    [Fact]
    public void ExactDuplicateIndexer_IsStillRejected()
    {
        var result = EmittedOracle.Evaluate("""
            class Twice {
                prop this[index int32] string -> "a"
                prop this[other int32] string -> "b"
            }
            0
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void AmbiguousIndexerCall_ReportsGs0266()
    {
        var result = EmittedOracle.Evaluate("""
            class Pair {
                prop this[a int32, b int64] string -> "left"
                prop this[a int64, b int32] string -> "right"
            }
            Pair()[1, 1]
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    [Fact]
    public void NoApplicableIndexer_ReportsGs0267()
    {
        var result = EmittedOracle.Evaluate(Table + "\nlet t = Table()\nt[1, 2, 3]");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0267");
        Assert.DoesNotContain(result.Diagnostics.Where(d => d.IsError), d => d.Id == "GS0102");
    }
}
