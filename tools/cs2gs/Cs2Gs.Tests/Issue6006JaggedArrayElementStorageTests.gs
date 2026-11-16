// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import System
import Xunit

class Issue6006JaggedArrayElementStorageTests {
    @Fact
    func SlicedRefElement_UsesTheSameDepthAsValueStores() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable disable
using System;
namespace Demo {
public class Node { public override string ToString() => "node"; }
public static class Use {
    static Range NextRange() { Console.Write("R"); return Range.All; }
    static void Clear(ref Node value) { value = null; }
    public static string Read() {
        var items = new Node[1][];
        items[0] = new Node[1];
        items[0][0] = new Node();
        Clear(ref items[NextRange()][0][0]);
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
}`, "Rstored|NRE", (printed string) -> Assert.Contains("Node?", printed, StringComparison.Ordinal), actualCli: true)
    }

    @Theory
    @InlineData("..")
    @InlineData("range")
    func SlicedReads_KeepTheScalarDepthAndAssertOnlyAtTheDereference(slice string) {
        Issue5609AuthorSuppressionTests.AssertRuns((`
#nullable disable
using System;
namespace Demo {
public class Node { public override string ToString() => "node"; }
public static class Use {
    public static string Read() {
        var items = new Node[1][];
        items[0] = new Node[1];
        Index first = new Index(0);
        Range range = Range.All;
        items[first][first] = new Node();
        Console.Write(items[first][first].ToString() + "|");
        items[0][0] = null;
        Console.Write("stored|");
        return items[SLICE][first][first].ToString();
    }
}
}`).Replace("SLICE", slice), `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read()); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "node|stored|NRE", (printed string) -> Assert.Contains("Node?", printed, StringComparison.Ordinal), actualCli: true)
    }

    @Theory
    @InlineData(
        "var alias = items[NextRange()]; alias[0] = new Node[1]; alias[0][0] = null;",
        "alias[0][0]",
        "Rnode|stored|NRE"
    )
    @InlineData("var alias = items[NextIndex()][NextRange()]; alias[0] = null;", "alias[0]", "IRnode|stored|NRE")
    func SlicedAliases_KeepStorageDepthWithoutChangingCopyOrEvaluationSemantics(
        setup string,
        read string,
        expected string
    ) {
        Issue5609AuthorSuppressionTests.AssertRuns((`
#nullable disable
using System;
namespace Demo {
public class Node { public override string ToString() => "node"; }
public static class Use {
    static int NextIndex() { Console.Write("I"); return 0; }
    static Range NextRange() { Console.Write("R"); return Range.All; }
    public static string Read() {
        var items = new Node[1][];
        items[0] = new Node[1];
        items[0][0] = new Node();
        SETUP
        Console.Write(items[0][0].ToString() + "|");
        Console.Write("stored|");
        return READ.ToString();
    }
}
}`).Replace("SETUP", setup).Replace("READ", read), `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read()); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, expected, (printed string) -> Assert.Contains("Node?", printed, StringComparison.Ordinal), actualCli: true)
    }

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
