// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import System
import Xunit

class Issue5994FlatDeconstructionStorageTests {
    @Theory
    @InlineData("var items = new Node[1]; items[0] = null; items[0] = new Node();", "arr[0]", "[]?Node?", "Node?")
    @InlineData(
        "var items = new Node?[1][]; items[0] = null; items[0] = new Node?[1];",
        "arr[0]",
        "[]?[]?Node?",
        "Node?[]?"
    )
    func MaterializedArrayLeaves_KeepNullableElementStorage(
        setup string,
        element string,
        storageType string,
        itemType string
    ) {
        Issue5609AuthorSuppressionTests.AssertRuns((`
#nullable disable
using System;
namespace Demo {
    public class Node { }
    public record Entry(ITEMTYPE Item, int Id);
    public static class Use {
        static Entry Empty() { Console.Write("D|"); return new Entry(null, 7); }
        public static int Read() {
            SETUP
            var pair = (items, 7);
            var (arr, _) = pair;
            int id;
            (ELEMENT, id) = Empty();
            Console.Write((ELEMENT == null ? "nil|" : "value|") + id + "|");
            arr = null;
            Console.Write("cleared|");
            return arr.Length;
        }
    }
}`).Replace("SETUP", setup).Replace("ELEMENT", element).Replace("ITEMTYPE", itemType), `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read()); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "D|nil|7|cleared|NRE", (
                printed string
            ) -> Assert.Contains("var arr " + storageType + " =", printed, StringComparison.Ordinal))
    }

    @Fact
    func OverwrittenCallback_PreservesTheInferredTypeParameterContract() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
using System;
namespace Demo {
    public static class Use {
        static void Keep<T>(ref T value) { }
        public static void Read<T>(T replacement) {
            var pair = (replacement, replacement);
            Action callback = () => {
                var (value, _) = pair;
                Keep<T>(ref value);
                Console.Write("unexpected");
            };
            callback = () => { };
            pair = (default(T), replacement);
            callback?.Invoke();
            Console.Write(replacement);
        }
    }
}`, `
public static class Host {
    public static void Main() {
        Demo.Use.Read("node");
        System.Console.Write("|");
        Demo.Use.Read(7);
    }
}`, "node|7", (printed string) -> Assert.DoesNotContain("var value T?", printed, StringComparison.Ordinal))
    }

    @Fact
    func RefWrites_UseTheActualNullableOrFixedStorageContract() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
using System;
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use {
        static void Keep(ref Node value) { Console.Write(value.ToString() + "|"); }
        static void Clear(ref Node? value) { value = null; Console.Write("write|"); }
        public static string Read(Entry entry) {
var (kept, _) = entry;
Keep(ref kept);
var (changed, _) = entry;
Console.Write(changed.ToString() + "|");
Clear(ref changed);
return changed.ToString();
        }
    }
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read(new Demo.Entry(new Demo.Node(), 7))); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "node|node|write|NRE", (
                printed string
            ) -> {
                Assert.DoesNotContain(
                    "kept Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "var changed Node?",
                    printed,
                    StringComparison.Ordinal
                )
            })
    }

    @Theory
    @InlineData("var (changed, _) = Next(entry);", "changed = null;")
    @InlineData("(Node? changed, int id) = Next(entry);", "changed = null;")
    @InlineData("(var changed, var id) = Next(entry);", "changed = null;")
    @InlineData("(Node? changed, int id) = (Next(entry).Item, 7);", "changed = null;")
    @InlineData("(var changed, var id) = (Next(entry).Item, 7);", "changed = null;")
    @InlineData("(var changed, var id) = NextTuple(entry);", "changed = null;")
    @InlineData("(int outer, (Node? changed, int id)) = (1, Next(entry));", "changed = null;")
    @InlineData("var (changed, _) = Next(entry);", "Clear(ref changed);")
    func NullableWritableLeaves_StoreNullBeforeTheDereference(declaration string, store string) {
        Issue5609AuthorSuppressionTests.AssertRuns((`
#nullable enable
using System;
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use {
        static Entry Next(Entry entry) { Console.Write("R|"); return entry; }
        static (Node, int) NextTuple(Entry entry) { Console.Write("R|"); return (entry.Item, entry.Id); }
        static void Clear(ref Node? value) { value = null; }
        public static string Read(Entry entry) {
            DECLARATION
            Console.Write(changed.ToString() + "|");
            STORE
            Console.Write(changed == null ? "stored|" : "value|");
            return changed.ToString();
        }
    }
}`).Replace("DECLARATION", declaration).Replace("STORE", store), `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read(new Demo.Entry(new Demo.Node(), 7))); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "R|node|stored|NRE", (
                printed string
            ) -> {
                Assert.Contains(
                    "var changed Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "return changed!!.ToString()",
                    printed,
                    StringComparison.Ordinal
                )
            })
    }

    @Fact
    func NullableTypedLeafWithoutWrites_DoesNotInheritPinnedReadProof() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use {
        public static string Read(Entry entry) {
            (Node? item, int id) = entry;
            return item.ToString() + id;
        }
    }
}`, `
public static class Host {
    public static void Main() {
        System.Console.Write(Demo.Use.Read(new Demo.Entry(new Demo.Node(), 7)) + "|");
        try { System.Console.Write(Demo.Use.Read(new Demo.Entry(null, 7))); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "node7|NRE", (
                printed string
            ) -> {
                Assert.Contains(
                    "let item Node?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "return item!!.ToString()",
                    printed,
                    StringComparison.Ordinal
                )
            })
    }

    @Theory
    @InlineData("var (changed, _) = Next();", "RDGI|node|stored|NRE")
    @InlineData("(Target? changed, int id) = Next();", "RDGIC|node|stored|NRE")
    func CustomDeconstruct_PreservesRhsGettersDiscardsAndConversionOrder(declaration string, expected string) {
        Issue5609AuthorSuppressionTests.AssertRuns((`
#nullable enable
using System;
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public class Target {
        public static implicit operator Target(Node? value) { Console.Write("C"); return new Target(); }
        public override string ToString() => "node";
    }
    public class Source {
        Node Item { get { Console.Write("G"); return new Node(); } }
        int Id { get { Console.Write("I"); return 7; } }
        public void Deconstruct(out Node? item, out int id) {
            Console.Write("D");
            item = Item;
            id = Id;
        }
    }
    public static class Use {
        static Source Next() { Console.Write("R"); return new Source(); }
        public static string Read() {
            DECLARATION
            Console.Write("|" + changed.ToString() + "|");
            changed = null;
            Console.Write(changed == null ? "stored|" : "value|");
            return changed.ToString();
        }
    }
}`).Replace("DECLARATION", declaration), `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read()); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, expected, (printed string) -> Assert.Contains("return changed!!.ToString()", printed, StringComparison.Ordinal))
    }

    @Fact
    func TypedDeconstructionStorage_ControlsLaterStoresAndSameNamedLocals() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable disable
using System;
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use {
        static Entry Empty() => new Entry(null, 0);
        public static void Read(Entry entry) {
            {
                (int outer, (Node changed, int id)) = (1, (new Node(), 7));
                try { (changed, _) = Empty(); Console.Write("stored|"); }
                catch (NullReferenceException) { Console.Write("bridge|"); }
                Console.Write(changed.ToString() + "|");
            }
            {
                (Node? changed, int id) = entry;
                (changed, _) = Empty();
                Console.Write(changed == null ? "nil" : "value");
            }
        }
    }
}`, `
public static class Host {
    public static void Main() {
        try { Demo.Use.Read(new Demo.Entry(new Demo.Node(), 7)); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "bridge|node|nil", (
                printed string
            ) -> {
                Assert.Contains(
                    "var changed Node =",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "var changed Node? =",
                    printed,
                    StringComparison.Ordinal
                )
            }, nativeExpected: "stored|NRE")
    }
}
