// <copyright file="Issue5541ObliviousContainerFlowTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import GSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #5541: one nested-position flow analysis decides which storage that
/// receives an imported oblivious container keeps nullable element positions, and
/// which reads of it need `!!`. Each test translates enabled C# that reads a
/// Roslyn-compiled oblivious library, compiles the output with no diagnostics,
/// verifies it with strict ILVerify before it runs, and compares each method's
/// result with the original C# compiled by Roslyn. A nil element stays nil where
/// C# keeps it, and throws (cref:NullReferenceException) where C# throws.
class Issue5541ObliviousContainerFlowTranslationTests : IDisposable {
    private let directory string = Path.Combine(
        Path.GetTempPath(),
        "cs2gs-5541-container-flow-" + Guid.NewGuid().ToString("N")
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            Directory.Delete(this.directory, recursive: true)
        } catch (IOException) {
            // Best effort: a loaded assembly can keep the file open on some hosts.

        } catch (UnauthorizedAccessException) {
            // Best effort, as above.

        }
    }

    /// Item 1: an extension or LINQ result and a lambda parameter take the nullable
    /// element of the storage. The lambda parameter states `string?`, and each
    /// dereference gets `!!`.
    @Fact
    func Linq_Results_And_Lambda_Parameters_Read_Nullable_Elements() {
        this.Check("Item1", `using System.Linq;
using ObLib;

public static class Use
{
    public static int First(string p) { string[] lines; lines = Node.Lines(p); return lines.First().Length + lines.Select(l => l.Length).Sum(); }
    public static int Where(string p) { string[] lines; lines = Node.Holes(p); return lines.Where(l => l != null).Count(); }
    public static int SelectThrows(string p) { string[] lines; lines = Node.Holes(p); try { return lines.Select(l => l.Length).Sum(); } catch (System.NullReferenceException) { return -1; } }
}`, []string{
                "return lines.First()!!.Length + lines.Select((l string?) -> l!!.Length).Sum()",
                "return lines.Where((l string?) -> l != nil).Count()"
            }, []string{"First", "6", "Where", "1", "SelectThrows", "-1"})
    }

    /// Item 2: a construction that converts the storage to another container type
    /// states the nullable type argument, so the copy keeps the nil element.
    @Fact
    func A_Construction_From_Storage_States_Nullable_Type_Arguments() {
        this.Check("Item2", `using System.Collections.Generic;
using ObLib;

public static class Use
{
    public static int Copy(string p)
    {
        string[] lines;
        lines = Node.Holes(p);
        var copy = new List<string>(lines);
        int nils = 0;
        foreach (var s in copy) { if (s == null) { nils++; } }
        return nils + copy.Count + copy[0].Length;
    }
}`, []string{"let copy = List[string?](lines)", "return nils + copy.Count + copy[0]!!.Length"}, []string{"Copy", "5"})
    }

    /// Item 3: an override, an interface implementation, the member it implements, an
    /// indexer and an `async` method state one signature with the nullable element.
    @Fact
    func Overrides_Implementations_Indexers_And_Async_Methods_Share_Nullable_Elements() {
        this.Check("Item3", `using System.Threading.Tasks;
using ObLib;

public interface IGet { string[] Get(string p); }
public class Getter : IGet { public string[] Get(string p) { return Node.Holes(p); } }
public abstract class Base { public abstract string[] Make(string p); }
public class Derived : Base { public override string[] Make(string p) { return Node.Lines(p); } }
public class Holder { public string[] this[string p] { get { return Node.Holes(p); } } }

public static class Use
{
    public static int Interface(string p) { IGet g = new Getter(); return g.Get(p)[0].Length + (g.Get(p)[1] == null ? 10 : 0); }
    public static int InterfaceThrows(string p) { IGet g = new Getter(); try { return g.Get(p)[1].Length; } catch (System.NullReferenceException) { return -1; } }
    public static int Override(string p) { Base b = new Derived(); return b.Make(p)[1].Length; }
    public static int Indexer(string p) { var h = new Holder(); return h[p][1] == null ? 1 : 0; }
    static async Task<string[]> LoadAsync(string p) { await Task.Yield(); return Node.Holes(p); }
    public static int Async(string p) { return LoadAsync(p).Result[1] == null ? 1 : 0; }
}`, []string{
                "func Get(p string) []string?;",
                "func Get(p string) []string? {",
                "open func Make(p string) []string?;",
                "open override func Make(p string) []string? {",
                "prop this[p string] []string? {",
                "private async func LoadAsync(p string) []string? {",
                "return g.Get(p)[0]!!.Length"
            }, []string{"Interface", "12", "InterfaceThrows", "-1", "Override", "2", "Indexer", "1", "Async", "1"})
    }

    /// Item 4: enabled storage that is stored as a whole into oblivious container
    /// storage states the same nullable element, so no conversion widens the
    /// element of a mutable container.
    @Fact
    func Storage_Stored_Into_Container_Storage_States_The_Same_Element() {
        this.Check("Item4", `using ObLib;

public static class Use
{
    public static int Back(string p)
    {
        string[] lines;
        lines = Node.Lines(p);
        string[] other = new string[1];
        other[0] = "x";
        lines = other;
        return lines[0].Length + other[0].Length;
    }
}`, []string{"let other []string? = [1]string?", "return lines[0]!!.Length + other[0]!!.Length"}, []string{"Back", "2"})
    }

    /// Item 5: a chained element read follows the storage's full position path, for
    /// nested generic containers and for jagged arrays.
    @Fact
    func Chained_Element_Reads_Follow_The_Full_Position_Path() {
        this.Check("Item5", `using System.Collections.Generic;
using ObLib;

public static class Use
{
    public static int Chained(string p) { List<List<string>> nested; nested = Node.Nested(p); return nested[0][0].Length + (nested[0][1] == null ? 10 : 0); }
    public static int Jagged(string p) { string[][] j; j = Node.Jagged(p); return j[0][0].Length + (j[0][1] == null ? 10 : 0); }
    public static int JaggedThrows(string p) { string[][] j; j = Node.Jagged(p); try { return j[0][1].Length; } catch (System.NullReferenceException) { return -1; } }
}`, []string{
                "var nested List[List[string?]?]",
                "return nested[0]!![0]!!.Length + (if nested[0]!![1] == nil { 10 } else { 0 })",
                "var j [][]?string?",
                "return j[0]!![1]!!.Length"
            }, []string{"Chained", "12", "Jagged", "12", "JaggedThrows", "-1"})
    }

    /// Item 6: a local that infers the platform container from its initializer is a
    /// source for other storage.
    @Fact
    func Inferred_Platform_Locals_Are_Sources() {
        this.Check("Item6", `using ObLib;

public static class Use
{
    public static int Inferred(string p) { var a = Node.Lines(p); string[] b; b = a; return b[0].Length; }
    public static int Typed(string p) { string[] a = Node.Holes(p); string[] b; b = a; return b[1] == null ? 1 : 0; }
}`, []string{"var b []string?", "return b[0]!!.Length"}, []string{"Inferred", "2", "Typed", "1"})
    }

    /// Item 7: the arms of a conditional, switch or coalescing value merge into the
    /// storage. Arms that give different positions make a local state the merged type.
    @Fact
    func Conditional_Switch_And_Coalescing_Arms_Merge() {
        this.Check("Item7", `using ObLib;

public static class Use
{
    public static int Conditional(string p) { string[] lines; lines = p.Length > 1 ? Node.Lines(p) : Node.Holes(p); return lines[1].Length; }
    public static int Coalesce(string p) { string[] lines; lines = Node.Holes(p) ?? Node.Lines(p); return lines[1] == null ? 1 : 0; }
    public static int Switch(string p) { string[] lines; lines = p.Length switch { 1 => Node.Lines(p), _ => Node.Holes(p) }; return lines[0].Length; }
    public static int MixedArms(string p) { string[] other = new string[] { "x" }; string[] lines = other ?? Node.Lines(p); return lines[0].Length; }
}`, []string{
                "lines = if p.Length > 1 { Node.Lines(p)!! } else { Node.Holes(p)!! }",
                "lines = Node.Holes(p) ?? Node.Lines(p)\n",
                "let lines []string? = other ?? Node.Lines(p)"
            }, []string{"Conditional", "2", "Coalesce", "1", "Switch", "2", "MixedArms", "1"})
    }

    /// Item 8: a `Dictionary` entry, key collection and value collection read the
    /// nullable positions of the dictionary.
    @Fact
    func Dictionary_Entries_Keys_And_Values_Read_Nullable_Positions() {
        this.Check("Item8", `using System.Collections.Generic;
using ObLib;

public static class Use
{
    public static int Entries(string p)
    {
        Dictionary<string, string> d;
        d = Node.Map(p);
        int n = 0;
        foreach (var kv in d) { n += kv.Value.Length + kv.Key.Length; }
        foreach (var k in d.Keys) { n += k.Length; }
        foreach (var v in d.Values) { n += v.Length; }
        return n;
    }
}`, []string{
                "n += kv.Value!!.Length + kv.Key!!.Length",
                "n += k!!.Length",
                "n += v!!.Length"
            }, []string{"Entries", "6"})
    }

    /// Item 9: a `foreach` variable that a nil test narrows needs no `!!`, so the
    /// output has no GS0536 warning.
    @Fact
    func A_Guarded_ForEach_Variable_Gets_No_Assertion() {
        this.Check("Item9", `using System.Collections.Generic;
using ObLib;

public static class Use
{
    public static int Guard(string p) { IEnumerable<string> xs; xs = Node.Seq(p); int n = 0; foreach (var s in xs) { if (s != null) { n += s.Length; } } return n; }
}`, []string{"if s != nil {\n                n += s.Length\n"}, []string{"Guard", "2"})
    }

    /// Item 10: a generic call result takes the nullable element of its argument,
    /// whether the method is source or imported from oblivious metadata.
    @Fact
    func Generic_Call_Results_Read_Nullable_Elements() {
        this.Check("Item10", `using ObLib;

public static class Use
{
    static T Id<T>(T x) { return x; }
    public static int Source(string p) { string[] lines; lines = Node.Holes(p); return Id(lines)[0].Length + (Id(lines)[1] == null ? 10 : 0); }
    public static int Imported(string p) { string[] lines; lines = Node.Holes(p); return Node.OId(lines)[0].Length; }
    public static int Stored(string p) { string[] lines; lines = Node.Holes(p); var copy = Id(lines); return copy[0].Length; }
    public static int Throws(string p) { string[] lines; lines = Node.Holes(p); try { return Id(lines)[1].Length; } catch (System.NullReferenceException) { return -1; } }
}`, []string{
                "return Id(lines)[0]!!.Length + (if Id(lines)[1] == nil { 10 } else { 0 })",
                "return Node.OId(lines)[0]!!.Length",
                "return copy[0]!!.Length"
            }, []string{"Source", "12", "Imported", "2", "Stored", "2", "Throws", "-1"})
    }

    /// Item 11: an explicit type argument and a declared return of a generic call
    /// result state the nullable element.
    @Fact
    func Explicit_Type_Arguments_And_Returns_State_Nullable_Elements() {
        this.Check("Item11", `using ObLib;

public static class Use
{
    static T Id<T>(T x) { return x; }
    public static int Explicit(string p) { string[] lines; lines = Node.Holes(p); return Id<string[]>(lines)[0].Length; }
    static string[] Pass(string p) { string[] lines; lines = Node.Holes(p); return Id(lines); }
    public static int Returned(string p) { return Pass(p)[1] == null ? 1 : 0; }
}`, []string{
                "return Id[[]string?](lines)[0]!!.Length",
                "private func Pass(p string) []string? {"
            }, []string{"Explicit", "2", "Returned", "1"})
    }

    // Translates the C#, checks the printed form, compiles and verifies the G#, and
    // compares each named method with the C# oracle and the expected result.
    private func Check(name string, source string, printedFragments[]string, expectations[]string) {
        Directory.CreateDirectory(this.directory)
        let libraryPath = Path.Combine(this.directory, "Lib5541" + name + ".dll")
        let library = CSharpCompilation.Create(
            "Lib5541" + name,
            []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource, CSharpParseOptions(LanguageVersion.Latest))},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
        )
        let libraryEmit = library.Emit(libraryPath)
        Assert.True(libraryEmit.Success, string.Join(Environment.NewLine, libraryEmit.Diagnostics))
        let reference = MetadataReference.CreateFromFile(libraryPath)
        let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest), path: "Snippet.cs")
        let consumer = CSharpCompilation.Create(
            "Use5541" + name + "CSharp",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences().Append(reference).ToImmutableArray(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        let oraclePath = Path.Combine(this.directory, "Use5541" + name + "CSharp.dll")
        let oracleEmit = consumer.Emit(oraclePath)
        Assert.True(oracleEmit.Success, string.Join(Environment.NewLine, oracleEmit.Diagnostics))
        let model = consumer.GetSemanticModel(tree)
        let document = LoadedDocument("Snippet.cs", tree, model)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                document,
                TranslationContext(consumer, model, document.FilePath)
            )
        )
            .Replace("\r\n", "\n")
        for fragment in printedFragments {
            Assert.Contains(fragment, printed, StringComparison.Ordinal)
        }
        let translated = this.CompileVerifyAndLoad(printed, libraryPath, "Use5541" + name)
        let oracle = EmittedFixture.Load(oraclePath)
        for var i = 0; i < expectations.Length; i += 2 {
            let expected = Invoke(oracle, expectations[i])
            Assert.Equal(expectations[i + 1], expected)
            Assert.Equal(expected, Invoke(translated, expectations[i]))
        }
    }

    // Compiles the translation as a library with no diagnostics, verifies it with the
    // repository ilverify before it runs, and loads it. A skipped verification fails.
    private func CompileVerifyAndLoad(printed string, libraryPath string, assemblyName string) Assembly {
        let path = Path.Combine(this.directory, assemblyName + ".dll")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let compilation = GCompilation(resolver, []GSyntaxTree{GSyntaxTree.Parse(GSourceText.From(printed))})
        compilation.IsLibrary = true
        {
            using let peStream = File.Create(path)
            let emit = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            Assert.True(emit.Success && emit.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", emit.Diagnostics))
        }
        let verification = IlVerifyRunner().Verify(path, []string{libraryPath})
        Assert.True(verification.Status == IlVerifyStatus.Passed, verification.Output)
        Assert.Empty(verification.Errors)
        return EmittedFixture.Load(path)
    }

    shared {
        private const LibrarySource string = `namespace ObLib;

public static class Node
{
    public static string[] Lines(string p) { return new[] { p, p }; }
    public static string[] Holes(string p) { return new[] { p, null }; }
    public static string[][] Jagged(string p) { return new[] { new[] { p, null } }; }
    public static System.Collections.Generic.List<System.Collections.Generic.List<string>> Nested(string p) { return new() { new() { p, null } }; }
    public static System.Collections.Generic.Dictionary<string, string> Map(string p) { return new() { { "k", p } }; }
    public static System.Collections.Generic.IEnumerable<string> Seq(string p) { return new[] { p, null }; }
    public static T OId<T>(T x) { return x; }
}`

        // The result of a public static `Use` method called with "ab": its value, or
        // the type of the exception it throws.
        private func Invoke(consumer Assembly, method string) string {
            let use = consumer.GetTypes().Single((type Type) -> type.Name == "Use")
            try {
                let value = use.GetMethod(method)!!.Invoke(nil, []object? {"ab"})
                return if value == nil {
                    "null"
                } else {
                    value.ToString() ?? "null"
                }
            } catch (exception TargetInvocationException) {
                return "throw:" + (exception.InnerException?.GetType().Name ?? "?")
            }
        }
    }
}
