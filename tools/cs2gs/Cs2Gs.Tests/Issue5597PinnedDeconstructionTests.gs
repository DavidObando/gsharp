// <copyright file="Issue5597PinnedDeconstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

class Issue5597PinnedDeconstructionTests {
    @Fact
    func PinnedNullArgument_LocalReadMatchesThePositionalDeclaration() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", `#nullable enable
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null!, 0);
        public static string Var(Entry entry) { var (item, _) = entry; return item.ToString(); }
        public static string Plain(Entry entry) => entry.Item.ToString();
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                document,
                TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            )
        )
        Assert.Equal(`package Demo

import System

open class Node {
    open override func ToString() string -> "node"
}

open data class Entry(Item Node, Id int32) : IEquatable[Entry] {
}

shared class Use {
    func Empty() Entry -> Entry(nil, 0)

    func Var(entry Entry) string {
        let (item, _) = entry
        return item.ToString()
    }

    func Plain(entry Entry) string -> entry.Item.ToString()
}
`, printed)
    }

    @Fact
    func DeclaredPositionalLocals_PreserveNativeOutputAcrossDeclarationForms() {
        LiteralConstructionRuntimeParity.AssertMatches(`
using System;
using System.Collections.Generic;
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static string Var(Entry entry) { var (item, _) = entry; return item.ToString(); }
        public static string Typed(Entry entry) { (Node item, int id) = entry; return item.ToString() + id; }
        public static string Nested(Entry entry)
        {
            (int outer, (Node item, int id)) = (2, entry);
            return item.ToString() + outer + id;
        }
        public static string Loop(List<Entry> entries)
        {
            string result = "";
            foreach (var (item, id) in entries) result += item.ToString() + id;
            return result;
        }
        public static string Plain(Entry entry) => entry.Item.ToString();
        public static void Main()
        {
            var entry = new Entry(new Node(), 1);
            Console.WriteLine(Var(entry) + "|" + Typed(entry) + "|" + Nested(entry) + "|" +
                Loop(new List<Entry> { entry }) + "|" + Plain(entry));
        }
    }
}`, verifyTranslation: (printed string) -> {
            Assert.DoesNotContain("item!!", printed, StringComparison.Ordinal)
            Assert.Contains("return item.ToString()", printed, StringComparison.Ordinal)
        }, verifyIL: true)
    }

    @Fact
    func SubstitutedPositionalIdentity_KeepsNullableElementsAsserted() {
        LiteralConstructionRuntimeParity.AssertMatches(`
using System;
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry<T>(T Item, int Id);
    public record Tagged<T>(Node Item, T Tag);
    public static class Use
    {
        public static string Read(Entry<Node> entry) { var (item, _) = entry; return item.ToString(); }
        public static string Tagged(Tagged<int> entry) { var (tagged, _) = entry; return tagged.ToString(); }
        public static string Nullable(Entry<Node?> entry)
        {
            var (optional, _) = entry;
            try { return optional.ToString(); }
            catch (NullReferenceException) { return "NRE"; }
        }
        public static void Main()
        {
            Console.WriteLine(Read(new Entry<Node>(new Node(), 1)) + "|" +
                Tagged(new Tagged<int>(new Node(), 2)) + "|" + Nullable(new Entry<Node?>(null, 3)));
        }
    }
}`, verifyTranslation: (printed string) -> {
            Assert.DoesNotContain("item!!", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("tagged!!", printed, StringComparison.Ordinal)
            Assert.Contains("optional!!.ToString()", printed, StringComparison.Ordinal)
        }, verifyIL: true)
    }
}
