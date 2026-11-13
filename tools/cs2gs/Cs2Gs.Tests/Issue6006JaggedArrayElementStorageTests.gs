// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import System
import Xunit

class Issue6006JaggedArrayElementStorageTests {
    @Fact
    func ObliviousJaggedAllocation_StoresNullInTheScalarElement() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable disable
namespace Demo {
public class Node { }
public static class Use {
    public static bool Read() {
        var items = new Node[1][];
        items[0] = new Node[1];
        items[0][0] = null;
        return items[0][0] == null;
    }
}
}`, `
public static class Host {
    public static void Main() { System.Console.Write(Demo.Use.Read()); }
}`, "True", (
                printed string
            ) -> {
                Assert.Contains(
                    "let items = [1][]Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "items[0] = [1]Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "!!",
                    printed,
                    StringComparison.Ordinal
                )
            }, actualCli: true)
    }

    @Theory
    @InlineData("var alias = items; alias[0][0][0] = null;")
    @InlineData("var row = items[0]; row[0][0] = null;")
    func NestedAliases_KeepTheScalarDepthSeparateFromArrayReferences(store string) {
        Issue5609AuthorSuppressionTests.AssertRuns((`
#nullable disable
namespace Demo {
public class Node { }
public static class Use {
    public static bool Read() {
        var items = new Node[1][][];
        items[0] = new Node[1][];
        items[0][0] = new Node[1];
        STORE
        return items[0][0][0] == null;
    }
}
}`).Replace("STORE", store), `
public static class Host {
    public static void Main() { System.Console.Write(Demo.Use.Read()); }
}`, "True", (
                printed string
            ) -> {
                Assert.Contains(
                    "let items = [1][][]Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "items[0] = [1][]Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "items[0][0] = [1]Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "!!",
                    printed,
                    StringComparison.Ordinal
                )
            }, actualCli: true)
    }

    @Fact
    func ReassignedRows_PreserveAllocationIndexAndNullReadOrder() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable disable
using System;
namespace Demo {
public class Node { public override string ToString() => "node"; }
public static class Use {
    static int Index(string text) { Console.Write(text); return 0; }
    static int Size(string text) { Console.Write(text); return 1; }
    public static string Read() {
        var items = new Node[Size("A")][];
        items[Index("B")] = new Node[Size("C")];
        items[Index("D")][Index("E")] = null;
        Console.Write(items[0][0] == null ? "nil|" : "value|");
        items[Index("F")] = new Node[Size("G")];
        items[0][0] = new Node();
        Console.Write(items[0][0].ToString() + "|");
        items[0][0] = null;
        Console.Write("stored|");
        return items[0][0].ToString();
    }
}
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read()); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "ABCDEnil|FGnode|stored|NRE", (
                printed string
            ) -> Assert.Contains("return items[0][0]!!.ToString()", printed, StringComparison.Ordinal), actualCli: true)
    }

    @Fact
    func NullablePositions_DoNotWidenSiblingArraysOrValueElements() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable disable
using System;
namespace Demo {
public class Node { public override string ToString() => "node"; }
public static class Use {
    public static bool Read() {
        var leaves = new Node[1][];
        leaves[0] = new Node[1];
        leaves[0][0] = null;
        var rows = new Node[1][];
        rows[0] = null;
        var outer = new Node[1][];
        outer[0] = new Node[1];
        outer[0][0] = new Node();
        Console.Write(outer[0][0].ToString() + "|");
        outer = null;
        var nonnull = new Node[1][];
        nonnull[0] = new Node[1];
        nonnull[0][0] = new Node();
        Console.Write(nonnull[0][0].ToString() + "|");
        var numbers = new int[1][];
        numbers[0] = new int[1];
        Console.Write(numbers[0][0] + "|");
        return leaves[0][0] == null && rows[0] == null && outer == null;
    }
}
}`, `
public static class Host {
    public static void Main() { System.Console.Write(Demo.Use.Read()); }
}`, "node|node|0|True", (
                printed string
            ) -> {
                Assert.Contains(
                    "let leaves = [1][]Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "let rows = [1][]?Node",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "var outer []?[]Node = [1][]Node",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "let nonnull = [1][]Node\n",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "let numbers = [1][]int32\n",
                    printed,
                    StringComparison.Ordinal
                )
            }, actualCli: true)
    }
}
