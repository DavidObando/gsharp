// <copyright file="Issue5597PinnedDeconstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Text.RegularExpressions
import Xunit

class Issue5597PinnedDeconstructionTests {
    @Fact
    func AnalyzerMappedPositionalElement_KeepsTheCanonicalNullableRead() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
namespace Demo {
    public record Entry(Microsoft.CodeAnalysis.INamespaceSymbol Item, int Id);
    public static class Use {
        public static object Read(Entry entry) {
            var (ns, _) = entry;
            return ns!;
        }
    }
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read(new Demo.Entry(null, 0)) == null ? "nil" : "value"); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "NRE", (
                printed string
            ) -> {
                Assert.Contains(
                    "Item string?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "return ns!!",
                    printed,
                    StringComparison.Ordinal
                )
            }, nativeExpected: "nil", analyzerApiMode: true)
    }

    @Fact
    func UserDeconstructWithPositionalNames_DoesNotInheritThePropertyContract() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id) {
        public void Deconstruct(out Node? Item, out int Id) { Item = null; Id = 0; }
    }
    public static class Use {
        public static string Read(Entry entry) {
            var (custom, _) = entry;
            return custom.ToString();
        }
    }
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read(new Demo.Entry(new Demo.Node(), 0))); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "NRE", (printed string) -> Assert.Contains("return custom!!.ToString()", printed, StringComparison.Ordinal))
    }

    @Fact
    func FrozenObliviousPositionalElement_KeepsItsUnknownReadAssertion() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable disable
namespace Demo {
    public static class Use {
        public static string Read(LegacyLib.Entry entry) {
            var (unknown, _) = entry;
            return unknown!.ToString();
        }
    }
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read(new LegacyLib.Entry(null, 0))); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "NRE", (
                printed string
            ) -> Assert.Contains("unknown!!.ToString()", printed, StringComparison.Ordinal), legacySource: `
namespace LegacyLib {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
}`)
    }

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
        AssertRejected(printed, []string{"GS0154:error:13,33,13,36"})
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
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
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
}`, `
using System;
using Demo;
public static class Host {
    static string Read(Func<Entry, string> read) {
        try { return read(new Entry(null, 0)); }
        catch (NullReferenceException) { return "NRE"; }
    }
    public static void Main() {
        Use.Main();
        Console.Write(Read(Use.Var) + "|" + Read(Use.Typed) + "|" + Read(Use.Nested) + "|" +
            Read(e => Use.Loop(new System.Collections.Generic.List<Entry> { e })) + "|" + Read(Use.Plain));
    }
}`, "node|node1|node21|node1|node" +
                Environment.NewLine +
                "NRE|NRE|NRE|NRE|NRE", (
                printed string
            ) -> {
                Assert.DoesNotContain(
                    "item!!",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "return item.ToString()",
                    printed,
                    StringComparison.Ordinal
                )
            })
    }

    @Fact
    func SubstitutedPositionalIdentity_KeepsNullableElementsAsserted() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
using System;
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry<T>(T Item, int Id);
    public record Tagged<T>(Node Item, T Tag);
    public static class Use
    {
        public static string Read(Entry<Node> entry) { var (item, _) = entry; return item.ToString(); }
        public static string ReadTagged(Tagged<int> entry) { var (tagged, _) = entry; return tagged.ToString(); }
        public static string Nullable(Entry<Node?> entry)
        {
            var (optional, _) = entry;
            try { return optional.ToString(); }
            catch (NullReferenceException) { return "NRE"; }
        }
        public static void Main()
        {
            Console.WriteLine(Read(new Entry<Node>(new Node(), 1)) + "|" +
                ReadTagged(new Tagged<int>(new Node(), 2)) + "|" + Nullable(new Entry<Node?>(null, 3)));
        }
    }
}`, `
using Demo;
public static class Host {
    public static void Main() { Use.Main(); }
}`, "node|node|NRE" +
                Environment.NewLine, (
                printed string
            ) -> {
                Assert.DoesNotContain(
                    "item!!",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "tagged!!",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "optional!!.ToString()",
                    printed,
                    StringComparison.Ordinal
                )
            })
    }

    @Fact
    func ExplicitNullableLocal_DoesNotInheritTheNonNullOrigin() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
using System;
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use {
        public static string Explicit(Entry entry) {
            (int outer, (Node? explicitItem, int id)) = (1, entry);
            try { return explicitItem.ToString(); }
            catch (NullReferenceException) { return "NRE"; }
        }
    }
}`, `
using Demo;
public static class Host {
    public static void Main() {
        var entry = new Entry(new Node(), 1);
        System.Console.Write(Use.Explicit(entry) + "|" + Use.Explicit(new Entry(null, 0)));
    }
}`, "node|NRE", (
                printed string
            ) -> {
                Assert.Contains(
                    "explicitItem!!.ToString()",
                    printed,
                    StringComparison.Ordinal
                )
            })
    }

    @Fact
    func ReassignedLocal_KeepsItsReadAssertionWithNullableStorage() {
        Issue5609AuthorSuppressionTests.AssertRuns(`
#nullable enable
namespace Demo {
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use {
        public static string Read(Entry entry) {
            var (changed, _) = entry;
            changed = null;
            return changed.ToString();
        }
    }
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Read(new Demo.Entry(new Demo.Node(), 0))); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "NRE", (printed string) -> Assert.Contains("return changed!!.ToString()", printed, StringComparison.Ordinal))
    }

    shared {
        private func AssertRejected(printed string, expected[]string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5597", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let source = Path.Combine(directory, "Probe.gs")
                let assembly = Path.Combine(directory, "Probe.dll")
                File.WriteAllText(source, printed)
                let compiler = LocalFunctionHoistTranslationTests.FindCompiler()
                Assert.NotNull(compiler)
                let result = ProcessRunner.Run(
                    "dotnet",
                    []string{compiler!!, "/target:library", "/out:" + assembly, source}
                )
                Assert.False(result.TimedOut, result.Output)
                Assert.Equal(1, result.ExitCode)
                let diagnostics = Regex.Matches(result.Output, `\((\d+,\d+,\d+,\d+)\): (error|warning) (GS\d+):`)
                Assert.NotEmpty(diagnostics)
                let actual = [diagnostics.Count]string
                for var i = 0; i < diagnostics.Count; i++ {
                    let groups = diagnostics[i].Groups
                    actual[i] = groups[3].Value + ":" + groups[2].Value + ":" + groups[1].Value
                }
                Assert.Equal(expected, actual)
                Assert.False(File.Exists(assembly))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
