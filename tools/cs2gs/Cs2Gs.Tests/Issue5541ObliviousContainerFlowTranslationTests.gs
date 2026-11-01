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

    /// Review of #5571: a construction that states a nullable type argument makes its
    /// element reads nullable even when no storage holds the container.
    @Fact
    func A_Construction_Without_Storage_Reads_Nullable_Elements() {
        this.Check("Review1", `using System.Collections.Generic;
using ObLib;

public static class Use
{
    public static int Read(string p) { return new List<string>(Node.Holes(p))[0].Length + (new List<string>(Node.Holes(p))[1] == null ? 10 : 0); }
    public static int Throws(string p) { try { return new List<string>(Node.Holes(p))[1].Length; } catch (System.NullReferenceException) { return -1; } }
}`, []string{"List[string?](Node.Holes(p)!!)[0]!!.Length"}, []string{"Read", "12", "Throws", "-1"})
    }

    /// Review of #5571: a base method that implements an interface member only through
    /// a derived class shares the interface member's signature.
    @Fact
    func An_Inherited_Interface_Implementation_Shares_The_Signature() {
        this.Check("Review2", `using ObLib;

public interface IGet { string[] Get(string p); }
public class Base { public string[] Get(string p) { return Node.Holes(p); } }
public class Derived : Base, IGet { }

public static class Use
{
    public static int Interface(string p) { IGet g = new Derived(); return g.Get(p)[1] == null ? 1 : 0; }
    public static int Direct(string p) { Base b = new Base(); return b.Get(p)[0].Length; }
}`, []string{
                "func Get(p string) []string?;",
                "func Get(p string) []string? {"
            }, []string{"Interface", "1", "Direct", "2"})
    }

    /// Review of #5571: a target-typed construction states the same nullable type
    /// argument as an explicit one.
    @Fact
    func A_Target_Typed_Construction_States_Nullable_Type_Arguments() {
        this.Check("Review3", `using System.Collections.Generic;
using ObLib;

public static class Use
{
    public static int Copy(string p)
    {
        string[] lines;
        lines = Node.Holes(p);
        List<string> copy = new(lines);
        return copy[0].Length + (copy[1] == null ? 10 : 0);
    }
}`, []string{"let copy = List[string?](lines)", "return copy[0]!!.Length"}, []string{"Copy", "12"})
    }

    /// Review of #5571: a type parameter whose constraint rejects a `T?` argument keeps
    /// its type argument and the argument's `!!`, for a call and a construction.
    @Fact
    func A_Constrained_Type_Parameter_Keeps_A_Non_Null_Argument() {
        this.Check("Review4", `using ObLib;

public class Box<T> where T : class
{
    public T Value;
    public Box(T value) { Value = value; }
}

public static class Use
{
    static T Keep<T>(T x) where T : class { return x; }
    public static int Explicit(string p) { string[] lines; lines = Node.Lines(p); return Keep<string>(lines[0]).Length; }
    public static int Constructed(string p) { string[] lines; lines = Node.Lines(p); return new Box<string>(lines[0]).Value.Length; }
    public static int Throws(string p) { string[] lines; lines = Node.Holes(p); try { return Keep<string>(lines[1]).Length; } catch (System.NullReferenceException) { return -1; } }
}`, []string{
                "Keep[string](lines[0]!!)",
                "Box[string](lines[0]!!)"
            }, []string{"Explicit", "2", "Constructed", "2", "Throws", "-1"})
    }

    /// Review of #5571: an expanded `params` argument passes a nil element through, so
    /// the parameter's element is nullable.
    @Fact
    func An_Expanded_Params_Argument_Passes_A_Nil_Element() {
        this.Check("Review5", `using ObLib;

public static class Use
{
    static int Count(params string[] values) { return values[0] == null ? 1 : 0; }
    public static int Expanded(string p) { string[] lines; lines = Node.Holes(p); return Count(lines[1]); }
}`, []string{"private func Count(values ...string?) int32 {", "return Count(lines[1])\n"}, []string{"Expanded", "1"})
    }

    /// Review of #5571: an argument for a parameter typed by a type argument that the
    /// call binds to a nullable position passes a nil element through, for a stated
    /// type argument, a construction and an inferred one. The call result then keeps
    /// its `!!` at a dereference.
    @Fact
    func A_Generic_Argument_Bound_To_A_Nullable_Type_Argument_Passes_Nil() {
        this.Check("Review6", `using ObLib;

public class Box<T>
{
    public T Value;
    public Box(T value) { Value = value; }
}

public static class Use
{
    static T Id<T>(T x) { return x; }
    public static int Explicit(string p) { string[] lines; lines = Node.Holes(p); return Id<string>(lines[1]) == null ? 1 : 0; }
    public static int Constructed(string p) { string[] lines; lines = Node.Holes(p); return new Box<string>(lines[1]).Value == null ? 1 : 0; }
    public static int Inferred(string p) { string[] lines; lines = Node.Lines(p); return Id(lines[0]).Length; }
    public static int InferredNil(string p) { string[] lines; lines = Node.Holes(p); return Id(lines[1]) == null ? 1 : 0; }
    public static int InferredThrows(string p) { string[] lines; lines = Node.Holes(p); try { return Id(lines[1]).Length; } catch (System.NullReferenceException) { return -1; } }
}`, []string{
                "return if Id[string?](lines[1]) == nil { 1 } else { 0 }",
                "return if Box[string?](lines[1]).Value == nil { 1 } else { 0 }",
                "return Id(lines[0])!!.Length",
                "return if Id(lines[1]) == nil { 1 } else { 0 }"
            }, []string{
                "Explicit",
                "1",
                "Constructed",
                "1",
                "Inferred",
                "2",
                "InferredNil",
                "1",
                "InferredThrows",
                "-1"
            })
    }

    /// Review of #5571: a block-bodied lambda returns a nullable element as it is when
    /// the call binds the delegate result to a nullable position.
    @Fact
    func A_Block_Lambda_Returns_A_Nullable_Element_Unchanged() {
        this.Check("Review7", `using System.Linq;
using ObLib;

public static class Use
{
    public static int Block(string p) { string[] lines; lines = Node.Holes(p); return lines.Select(l => { return l; }).Count(x => x == null); }
    public static int BlockFirst(string p) { string[] lines; lines = Node.Holes(p); return lines.Select(l => { return l; }).First().Length; }
}`, []string{"return l\n", ").First()!!.Length"}, []string{"Block", "1", "BlockFirst", "2"})
    }

    /// Review of #5571: a local that a G# nil test narrows passes a non-null value to a
    /// generic call and to a local that takes its type from it, so neither result gets
    /// a redundant `!!` (GS0536).
    @Fact
    func A_Narrowed_Local_Gives_A_Non_Null_Generic_Result() {
        this.Check("Review8", `using System.Collections.Generic;
using ObLib;

public static class Use
{
    static T Id<T>(T x) { return x; }
    public static int Guard(string p)
    {
        IEnumerable<string> xs;
        xs = Node.Seq(p);
        int n = 0;
        foreach (var s in xs)
        {
            if (s != null)
            {
                var t = Id(s);
                n += t.Length + Id(s).Length;
            }
        }
        return n;
    }
}`, []string{"n += t.Length + Id(s).Length"}, []string{"Guard", "4"})
    }

    /// Review of #5571: enabled storage that an `async` method returns as its task's
    /// result states the result's nullable element, so no conversion widens it.
    @Fact
    func Storage_Returned_By_An_Async_Method_States_The_Result_Element() {
        this.Check("Review9", `using System.Threading.Tasks;
using ObLib;

public static class Use
{
    static async Task<string[]> Load(string p, bool flag)
    {
        await Task.Yield();
        string[] other = new string[1];
        other[0] = "x";
        if (flag) { return Node.Holes(p); }
        return other;
    }

    public static int Async(string p) { return Load(p, false).Result[0].Length + (Load(p, true).Result[1] == null ? 10 : 0); }
}`, []string{
                "private async func Load(p string, flag bool) []string? {",
                "let other []string? = [1]string?"
            }, []string{"Async", "11"})
    }

    /// Review of #5571: an awaited generic result reads the nullable position that the
    /// awaitable's argument gives it, so a dereference gets `!!` and a nil test does not.
    @Fact
    func An_Awaited_Generic_Result_Reads_A_Nullable_Element() {
        this.Check("Review10", `using System.Threading.Tasks;
using ObLib;

public static class Use
{
    static Task<T> AsTask<T>(T x) { return Task.FromResult(x); }
    static async Task<int> ReadAsync(string p) { string[] lines; lines = Node.Lines(p); return (await AsTask(lines[0])).Length; }
    static async Task<int> NilAsync(string p) { string[] lines; lines = Node.Holes(p); return (await AsTask(lines[1])) == null ? 1 : 0; }
    static async Task<int> ThrowsAsync(string p) { string[] lines; lines = Node.Holes(p); try { return (await AsTask(lines[1])).Length; } catch (System.NullReferenceException) { return -1; } }
    public static int Await(string p) { return ReadAsync(p).Result; }
    public static int AwaitNil(string p) { return NilAsync(p).Result; }
    public static int AwaitThrows(string p) { return ThrowsAsync(p).Result; }
}`, []string{
                "return (await AsTask(lines[0]))!!.Length",
                "return if (await AsTask(lines[1])) == nil { 1 } else { 0 }"
            }, []string{"Await", "2", "AwaitNil", "1", "AwaitThrows", "-1"})
    }

    /// Review of #5571: a configured awaitable (`ConfigureAwait(false)`) and a value task
    /// carry the result's nullable element through `GetAwaiter().GetResult()`.
    @Fact
    func A_Configured_Await_Keeps_The_Result_Element() {
        this.Check("Review11", `using System.Threading.Tasks;
using ObLib;

public static class Use
{
    static async Task<string[]> LoadAsync(string p) { await Task.Yield(); return Node.Holes(p); }
    static async ValueTask<string[]> LoadValueAsync(string p) { await Task.Yield(); return Node.Holes(p); }
    static async Task<int> CopyAsync(string p) { var copy = await LoadAsync(p).ConfigureAwait(false); return copy[0].Length + (copy[1] == null ? 10 : 0); }
    static async Task<int> ValueAsync(string p) { var copy = await LoadValueAsync(p).ConfigureAwait(false); return copy[0].Length; }
    public static int Configured(string p) { return CopyAsync(p).Result; }
    public static int Value(string p) { return ValueAsync(p).Result; }
}`, []string{
                "return copy[0]!!.Length + (if copy[1] == nil { 10 } else { 0 })"
            }, []string{"Configured", "12", "Value", "2"})
    }

    /// Review of #5571: an expanded `params T[]` argument for a type argument that the
    /// call binds to `T?` passes a nil element through.
    @Fact
    func An_Expanded_Generic_Params_Argument_Passes_A_Nil_Element() {
        this.Check("Review12", `using ObLib;

public static class Use
{
    static T[] Pack<T>(params T[] xs) { return xs; }
    public static int Stated(string p) { string[] lines; lines = Node.Holes(p); return Pack<string>(lines[1])[0] == null ? 1 : 0; }
    public static int Inferred(string p) { string[] lines; lines = Node.Holes(p); return Pack(lines[1])[0] == null ? 1 : 0; }
}`, []string{
                "return if Pack[string?](lines[1])[0] == nil { 1 } else { 0 }",
                "return if Pack(lines[1])[0] == nil { 1 } else { 0 }"
            }, []string{"Stated", "1", "Inferred", "1"})
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
