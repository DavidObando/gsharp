// <copyright file="Adr0186ObliviousMetadataReadTranslationTests.cs" company="GSharp">
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

/// ADR-0186 step 6 (PR 0): a read of oblivious CLR metadata that no project in
/// the migration run emits is the platform type `T!` in gsc (since step
/// 3), and gsc inserts the nil check itself wherever such a value is coerced
/// to a non-null reference, receivers included. cs2gs therefore leaves those
/// reads bare instead of emitting `!!`.
///
/// These tests compile the translation against a real oblivious assembly, so
/// they witness what the string assertions elsewhere cannot: that the bare
/// output binds, that a nil still throws (cref:NullReferenceException)
/// at the same point, and that the two carve-outs (a member this run also
/// migrates, and a value whose platform-ness would reach type inference) keep
/// their `!!`.
class Adr0186ObliviousMetadataReadTranslationTests : IDisposable {
    private let directory string = Path.Combine(
        Path.GetTempPath(),
        "cs2gs-adr0186-oblivious-read-" + Guid.NewGuid().ToString("N")
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

    /// Receivers, an assignment and a return that read oblivious
    /// metadata carry no `!!`, and the output binds against that metadata.
    /// Restoring the pre-step-3 `T?` mirror rule puts the `!!` back
    /// and fails the first assertion.
    @Fact
    func Oblivious_Metadata_Reads_Are_Left_Bare_And_Bind() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousReadLib")
        let printed = Translate(
            ConsumerSource,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable
        )
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        Assert.Contains("n.Next.Name.Length", printed, StringComparison.Ordinal)
        Assert.Contains("n.Next.Describe()", printed, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        TranslationTestValidation.AssertBinds(resolver, printed)
    }

    /// The runtime half: with no `!!` in the output, a nil read through
    /// oblivious metadata still throws (cref:NullReferenceException),
    /// because gsc checks the `T!` receiver itself. That is the same
    /// exception, at the same dereference, that C# and the old `!!` gave.
    @Fact
    func A_Nil_Oblivious_Read_Still_Throws_NullReferenceException() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousRuntimeLib")
        let printed = Translate(
            ConsumerSource,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable
        )
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        let present = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Probe(Node.Make(\"a\", Node.Make(\"abc\", nil)))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.Empty(present.Diagnostics)
        Assert.Equal(3, present.Value)
        let missing = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Probe(Node.Make(\"a\", nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.Empty(missing.Diagnostics)
        Assert.Equal(-1, missing.Value)
    }

    /// A container read keeps its `!!`. An oblivious method returning
    /// `string[]` reads as `[]!string!`. `!!` strips only the top level, and
    /// ADR-0186 §3 rule 3 gives `[]string!` no conversion to `[]string`, so the
    /// local stores nullable elements: `[]string?` (#5537). This is the netstandard2.0
    /// `Gsharp.NET.Sdk` shape
    /// (`lines = File.ReadAllLines(path)`, #4449 and #5413 decision A). The compile
    /// check fails if the local keeps `[]string` or the assertion is dropped.
    @Fact
    func A_Container_Read_Keeps_Its_Assertion() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousContainerLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static int Count(string p)
    {
        string[] lines;
        lines = Node.Lines(p);
        return lines.Length;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Enable)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Count(\"x\")"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(2, result.Value)
        Assert.Contains("var lines []string?", printed, StringComparison.Ordinal)
        Assert.Contains("Node.Lines(p)!!", printed, StringComparison.Ordinal)
    }

    /// Issue #5537: every storage kind that receives an imported oblivious
    /// container keeps nullable elements. Array and `List` locals, an inferred
    /// local that is also assigned, a field, a parameter, a method return, and an
    /// alias of such storage use the same rule. A construction stored there spells
    /// the same element type. An indexer, field, property, or method result typed by
    /// the container's type parameter is an element read. Only
    /// the producer's platform positions change: a type-argument position keeps the
    /// contract of the argument, and an array element that is a type parameter of the
    /// call stays `[]T`. An array member is not an element read, and an inferred
    /// local keeps its outer nullability. A non-null element dereference, return, or argument gets
    /// `!!`. A nullable return, a nullable argument, and a nil test do not. A nil
    /// element throws (cref:NullReferenceException) at the same use as in C#. The
    /// emitted image has no diagnostics and passes strict ILVerify before it runs.
    @Fact
    func Container_Storage_Keeps_Nullable_Elements() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousContainerStorageLib")
        let printed = Translate(`using System.Collections.Generic;
using ObLib;

public class Store
{
    public string[] Lines = new string[0];

    public void Load(string p)
    {
        Lines = Node.Lines(p);
    }
}

public static class Use
{
    public static int ArrayLocal(string p)
    {
        string[] lines;
        lines = Node.Lines(p);
        string first = lines[1];
        return lines[0].Length + first.Length;
    }

    public static int ListLocal(string p)
    {
        List<string> items;
        items = Node.Items(p);
        int total = 0;
        foreach (string item in items)
        {
            total += item.Length;
        }
        return total + items[1].Length;
    }

    public static int Field(string p)
    {
        Store store = new Store();
        store.Load(p);
        return store.Lines[1].Length;
    }

    public static int Parameter(string[] values)
    {
        return values[0].Length;
    }

    public static int Argument(string p)
    {
        return Parameter(Node.Lines(p));
    }

    public static string[] Returned(string p)
    {
        return Node.Lines(p);
    }

    public static int Return(string p)
    {
        return Returned(p)[0].Length;
    }

    public static int TypeArgumentArray(string p)
    {
        string[] empty;
        empty = Node.Empty<string>();
        return empty.Length;
    }

    public static string? NullableReturn(string p)
    {
        string[] lines;
        lines = Node.Holes(p);
        return lines[1];
    }

    private static int? MaybeLength(string? value)
    {
        return value?.Length;
    }

    public static int NullableArgument(string p)
    {
        string[] lines;
        lines = Node.Holes(p);
        return MaybeLength(lines[1]) == null ? 1 : 0;
    }

    private static int Length(string value)
    {
        return value.Length;
    }

    public static string NonNullReturn(string p)
    {
        string[] lines;
        lines = Node.Lines(p);
        return lines[0];
    }

    public static int NonNullArgument(string p)
    {
        string[] lines;
        lines = Node.Lines(p);
        return Length(lines[0]);
    }

    public static int MixedWrites(string p)
    {
        string[] mixed = Node.Lines(p);
        mixed = new[] { "ok" };
        return mixed[0].Length;
    }

    public static int ReassignedInferredLocal(string p)
    {
        var items = new List<string>();
        items = Node.Items(p);
        return items[0].Length;
    }

    public static int NestedTypeArgument(string p)
    {
        List<List<string>> nested;
        nested = Wrapping.Wrap(new List<string> { p });
        return nested[0][0].Length;
    }

    public static int Alias(string p)
    {
        string[] lines;
        lines = Node.Holes(p);
        var alias = lines;
        return alias[0].Length;
    }

    public static int MemberResult(string p)
    {
        Box<string> box;
        box = Node.MakeBox(p);
        return box.Value.Length + box.Get().Length;
    }

    public static int ArrayMember(string p)
    {
        string[] lines;
        lines = Node.Lines(p);
        return lines.Length.ToString().Length;
    }

    public static int NullableInferredLocal(string p)
    {
        var items = new List<string>();
        items = Node.Items(p);
        items = null;
        return items == null ? 2 : -1;
    }

    public static int NilElementIsNotUsed(string p)
    {
        string[] lines;
        lines = Node.Holes(p);
        string? kept = lines[1];
        return lines[1] == null && kept == null ? 1 : 0;
    }

    public static int NilElementThrows(string p)
    {
        string[] lines;
        lines = Node.Holes(p);
        try
        {
            return lines[1].Length;
        }
        catch (System.NullReferenceException)
        {
            return -1;
        }
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Enable)
        let consumer = this.CompileVerifyAndLoad(printed, libraryPath, "Adr0186ObliviousContainerStorageConsumer")
        Assert.Equal(4, Invoke(consumer, "ArrayLocal", "ab"))
        Assert.Equal(6, Invoke(consumer, "ListLocal", "ab"))
        Assert.Equal(2, Invoke(consumer, "Field", "ab"))
        Assert.Equal(2, Invoke(consumer, "Argument", "ab"))
        Assert.Equal(2, Invoke(consumer, "Return", "ab"))
        Assert.Equal(0, Invoke(consumer, "TypeArgumentArray", "ab"))
        Assert.Null(Invoke(consumer, "NullableReturn", "ab"))
        Assert.Equal(1, Invoke(consumer, "NullableArgument", "ab"))
        Assert.Equal("ab", Invoke(consumer, "NonNullReturn", "ab"))
        Assert.Equal(2, Invoke(consumer, "NonNullArgument", "ab"))
        Assert.Equal(2, Invoke(consumer, "MixedWrites", "ab"))
        Assert.Equal(2, Invoke(consumer, "ReassignedInferredLocal", "ab"))
        Assert.Equal(2, Invoke(consumer, "NestedTypeArgument", "ab"))
        Assert.Equal(2, Invoke(consumer, "Alias", "ab"))
        Assert.Equal(4, Invoke(consumer, "MemberResult", "ab"))
        Assert.Equal(1, Invoke(consumer, "ArrayMember", "ab"))
        Assert.Equal(2, Invoke(consumer, "NullableInferredLocal", "ab"))
        Assert.Equal(1, Invoke(consumer, "NilElementIsNotUsed", "ab"))
        Assert.Equal(-1, Invoke(consumer, "NilElementThrows", "ab"))
        let normalized = printed.Replace("\r\n", "\n")
        for expected in[]string{
            "var lines []string?",
            "lines = Node.Lines(p)!!",
            "let first = lines[1]!!",
            "return lines[0]!!.Length + first.Length",
            "var items List[string?]",
            "items = Node.Items(p)!!",
            "total += item!!.Length",
            "return total + items[1]!!.Length",
            "var Lines []string? = [0]string?\n",
            "return store.Lines[1]!!.Length",
            "func Parameter(values []string?) int32 {",
            "return values[0]!!.Length",
            "return Parameter(Node.Lines(p)!!)",
            "func Returned(p string) []string? {",
            "return Returned(p)[0]!!.Length",
            "var empty []string\n",
            "let kept string? = lines[1]\n",
            "return if lines[1] == nil && kept == nil { 1 } else { 0 }",
            "return lines[1]!!.Length",
            "return lines[1]\n",
            "return if MaybeLength(lines[1]) == nil { 1 } else { 0 }",
            "return lines[0]!!\n",
            "return Length(lines[0]!!)",
            "var mixed []string? = Node.Lines(p)!!",
            "mixed = []string?{\"ok\"}",
            "return mixed[0]!!.Length",
            "var items List[string?] = List[string?]()",
            "return items[0]!!.Length",
            "var nested List[List[string]?]\n",
            "return nested[0]!![0].Length",
            "let alias []string? = lines",
            "return alias[0]!!.Length",
            "var box Box[string?]",
            "return box.Value!!.Length + box.Get()!!.Length",
            "return lines.Length.ToString().Length",
            "var items List[string?]? = List[string?]()"
        } {
            Assert.Contains(expected, normalized, StringComparison.Ordinal)
        }
    }

    /// A member declared in a project this run also migrates is not frozen
    /// metadata: cs2gs decides its emitted type, which is `T` or a
    /// promoted `T?`, never `T!`. Its reads keep the existing rule.
    /// Dropping the frozen-metadata gate removes these `!!`.
    @Fact
    func A_Member_This_Run_Migrates_Keeps_Its_Assertion() {
        let library = CompileLibrary("Adr0186ObliviousSiblingLib")
        let printed = Translate(ConsumerSource, library.ToMetadataReference(), NullableContextOptions.Disable)
        Assert.Contains("n.Next!!", printed, StringComparison.Ordinal)
    }

    /// A value whose platform-ness would reach type inference keeps its
    /// `!!`: `Wrap(n.Name)` would otherwise infer
    /// `List[string!]`, which ADR-0186 §3 rule 3 does not convert to the
    /// `List[string]` the local declares (GS0155). The compile check
    /// fails if the assertion is dropped.
    @Fact
    func A_Value_That_Feeds_Inference_Keeps_Its_Assertion() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousInferenceLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static int Count(Node n)
    {
        System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
        names = Wrapping.Wrap(n.Name);
        return names.Count;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.Contains("Wrap(n.Name!!)", printed, StringComparison.Ordinal)
        // Compiled through gsc's `/r:` channel, which resolves the generic
        // `List<T>` return (the metadata-only binder resolver does not).
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    /// An implicitly typed local takes its type from its initializer, so its
    /// initializer is an inference position too. Without the `!!`,
    /// `var name = n.Name` makes `name` a `string!`, and
    /// `Wrap(name)` then infers `List[string!]` (GS0155).
    @Fact
    func An_Implicitly_Typed_Local_Keeps_The_Assertion() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousLocalInferenceLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static int Count(Node n)
    {
        System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
        var name = n.Name;
        names = Wrapping.Wrap(name);
        return names.Count;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.Contains("let name = n.Name!!", printed, StringComparison.Ordinal)
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(1, result.Value)
    }

    /// A `for` statement's local takes its type from its initializer just
    /// like a statement-level `var` local, so it keeps the `!!`.
    /// Without it, `name` is `string!` and `Wrap(name)` infers
    /// `List[string!]` (GS0155).
    @Fact
    func A_For_Statement_Local_Keeps_The_Assertion() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousForLocalLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static int Count(Node n)
    {
        System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
        int passes = 0;
        for (var name = n.Name; passes < 1; passes++)
        {
            names = Wrapping.Wrap(name);
        }

        return names.Count;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.Contains("n.Name!!", printed, StringComparison.Ordinal)
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(1, result.Value)
    }

    /// A tuple element deconstructed into a new local is an inference
    /// position too: `var (name, _) = (n.Name, 0)` gives `name` the
    /// element's type, so the element keeps its `!!`. Without it
    /// `name` is `string!` and `Wrap(name)` infers
    /// `List[string!]` (GS0155). An element deconstructed into an
    /// existing variable has a fixed target and stays bare.
    @Fact
    func A_Deconstructed_Local_Keeps_The_Assertion() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousDeconstructLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static int Count(Node n)
    {
        System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
        var (name, _) = (n.Name, 0);
        names = Wrapping.Wrap(name);
        return names.Count;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.Contains("n.Name!!", printed, StringComparison.Ordinal)
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(1, result.Value)
    }

    /// An array of a value type has no nested reference position, so an
    /// oblivious `int[]` read is left bare like a scalar one. Returned
    /// from a method declared `int[]?`, a nil flows through instead of
    /// throwing. The oracle passes a nil and expects `true`.
    @Fact
    func A_Value_Element_Array_Read_Is_Left_Bare() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousIntArrayLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static int[]? Get(bool nil)
    {
        return Node.Ints(nil);
    }

    public static bool IsMissing(bool nil)
    {
        return Get(nil) == null;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Enable)
        Assert.DoesNotContain("Node.Ints(nil)!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.IsMissing(true)"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    /// A tuple literal's element binds no parameter, so it is classified from
    /// its tuple. Passed to a fixed `(string?, int)` parameter nothing is
    /// inferred, the read stays bare, and a nil reaches the nullable element
    /// instead of throwing. The oracle passes a nil and expects `true`.
    @Fact
    func A_Tuple_Element_With_A_Fixed_Target_Is_Left_Bare() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousTupleLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static bool Accept((string?, int) pair)
    {
        return pair.Item1 == null;
    }

    public static bool Probe(Node n)
    {
        return Accept((n.Name, 0));
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Enable)
        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Probe(Node.Make(nil, nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    /// A lambda whose target delegate already returns `T?` has a fixed,
    /// nullable result type, so its result is not an inference position and
    /// stays bare. With a `!!` there, a nil name would throw where the
    /// C# returns `null`. The oracle passes a nil and expects
    /// `true`.
    @Fact
    func A_Lambda_With_A_Nullable_Target_Return_Leaves_Its_Result_Bare() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousLambdaLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static bool NameIsNil(Node n)
    {
        System.Func<string?> read = () => { return n.Name; };
        return read() == null;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.NameIsNil(Node.Make(nil, nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    /// A local declared `T?` keeps its type clause, so its initializer is
    /// not an inference position: `string? value = flag ? n.Name : null`
    /// leaves `n.Name` bare, and a nil name flows into the local rather
    /// than throwing.
    @Fact
    func A_Nullable_Local_Leaves_Its_Initializer_Bare() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousNullableLocalLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static bool NameIsNil(Node n, bool flag)
    {
        string? value = flag ? n.Name : null;
        return value == null;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Enable)
        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.NameIsNil(Node.Make(nil, nil), true)"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    /// A `var` local that cs2gs emits with a nullable type clause (here
    /// because it is compared with `null`, so it becomes
    /// `let name string? = n.Name`) leaves its initializer bare too, so
    /// the null check sees a nil name instead of a throw. The initializer
    /// then targets a `T?` clause, so no bridge is ever considered.
    @Fact
    func A_Var_Local_Emitted_Nullable_Leaves_Its_Initializer_Bare() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousVarNullableLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static bool NameIsNil(Node n)
    {
        var name = n.Name;
        if (name == null)
        {
            return true;
        }

        return false;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.NameIsNil(Node.Make(nil, nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    /// A frozen read inside a conditional that `??` then absorbs is not
    /// asserted either: a nil name reaches the fallback, as in C#.
    @Fact
    func A_Read_Absorbed_By_A_Coalesce_Reaches_The_Fallback() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousCoalesceLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static string Pick(Node n, bool flag)
    {
        return (flag ? n.Name : "") ?? "fallback";
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Pick(Node.Make(nil, nil), true)"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal("fallback", result.Value)
    }

    /// A lambda passed where its delegate type is inferred keeps its result's
    /// `!!`: `Select(x => x.Name)` would otherwise infer
    /// `IEnumerable[string!]`, and `ToList()` a `List[string!]`
    /// that the declared `List[string]` does not accept (GS0155).
    @Fact
    func A_Lambda_Whose_Type_Is_Inferred_Keeps_Its_Result_Assertion() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousSelectLib")
        let printed = Translate(`using System.Linq;
using ObLib;

public static class Use
{
    public static int Count(Node n)
    {
        System.Collections.Generic.List<string> names = new[] { n }.Select(x => x.Name).ToList();
        return names.Count;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.Contains("x.Name!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(1, result.Value)
    }

    /// A lambda converted to an oblivious delegate (`Reader`, whose Invoke
    /// returns `string!`) has a fixed result type too, so its result stays
    /// bare, and a nil name is returned rather than thrown. That holds for a
    /// lambda reached through a conditional as well.
    @Fact
    func A_Lambda_With_An_Oblivious_Target_Return_Leaves_Its_Result_Bare() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousDelegateLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static bool NameIsNil(Node n)
    {
        Reader read = () => n.Name;
        return read() == null;
    }

    public static bool ChosenNameIsNil(Node n, bool flag)
    {
        Reader read = flag ? (() => n.Name) : (() => "");
        return read() == null;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{
                printed +
                    Environment.NewLine +
                    "Use.NameIsNil(Node.Make(nil, nil)) && Use.ChosenNameIsNil(Node.Make(nil, nil), true)"
            },
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    /// Explicit type arguments leave nothing to infer, so the inference
    /// carve-out does not apply: `IsNil<string>(n.Name)` stays bare.
    /// With the old `!!`, a nil name threw instead of reaching the
    /// callee, which C# never did. The oracle passes a nil and expects
    /// `true`.
    @Fact
    func Explicit_Type_Arguments_Do_Not_Keep_The_Assertion() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousExplicitLib")
        let printed = Translate(`using ObLib;

public static class Use
{
    public static bool NameIsNil(Node n)
    {
        return Wrapping.IsNil<string>(n.Name);
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            []string{printed + Environment.NewLine + "Use.NameIsNil(Node.Make(nil, nil))"},
            EmittedOracleOptions{References: []string{libraryPath}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    /// An unqualified inherited member used as an assignment-target receiver
    /// (`Child.Name = value`, where `Child` comes from an oblivious
    /// base class) is the same platform-typed read, so it stays bare too.
    @Fact
    func An_Inherited_Oblivious_Member_As_An_Assignment_Receiver_Is_Left_Bare() {
        let libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousInheritedLib")
        let printed = Translate(`using ObLib;

public class Derived : Holder
{
    public void Rename(string value)
    {
        Child.Name = value;
    }
}`, MetadataReference.CreateFromFile(libraryPath), NullableContextOptions.Disable)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        Assert.Contains("this.Child.Name = value", printed, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        TranslationTestValidation.AssertBinds(resolver, printed)
    }

    // Compiles the translation as a library, verifies it with the repository
    // ilverify before it runs, and loads it. A skipped verification fails.
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

    private func EmitObliviousLibrary(assemblyName string) string {
        Directory.CreateDirectory(this.directory)
        let path = Path.Combine(this.directory, assemblyName + ".dll")
        let emit = CompileLibrary(assemblyName).Emit(path)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        return path
    }

    shared {
        private const LibrarySource string = `namespace ObLib;

public class Node
{
    public string Name;
    public Node Next;
    public static Node Make(string name, Node next)
    {
        var node = new Node();
        node.Name = name;
        node.Next = next;
        return node;
    }
    public string Describe() { return "node"; }
    public static string[] Lines(string p) { return new[] { p, p }; }
    public static string[] Holes(string p) { return new[] { p, null }; }
    public static T[] Empty<T>() { return new T[0]; }
    public static Box<string> MakeBox(string p) { var box = new Box<string>(); box.Value = p; return box; }
    public static System.Collections.Generic.List<string> Items(string p) { return new System.Collections.Generic.List<string> { p, p }; }
    public static int[] Ints(bool nil) { return nil ? null : new[] { 1, 2 }; }
}

public static class Wrapping
{
    public static System.Collections.Generic.List<T> Wrap<T>(T value)
    {
        return new System.Collections.Generic.List<T> { value };
    }

    public static bool IsNil<T>(T value) where T : class
    {
        return value == null;
    }
}

public class Box<T>
{
    public T Value;
    public T Get() { return Value; }
}

public class Holder
{
    public Node Child;
}

public delegate string Reader();`

        private const ConsumerSource string = `using ObLib;

public static class Use
{
    public static int NextNameLength(Node n)
    {
        return n.Next.Name.Length;
    }

    public static string Describe(Node n)
    {
        return n.Next.Describe();
    }

    public static string Keep(Node n)
    {
        string kept = "";
        kept = n.Next.Name;
        return kept;
    }

    public static int Probe(Node n)
    {
        try
        {
            return NextNameLength(n);
        }
        catch (System.NullReferenceException)
        {
            return -1;
        }
    }
}`

        private func Invoke(consumer Assembly, method string, argument string) object? {
            let use = consumer.GetTypes().Single((type Type) -> type.Name == "Use")
            return use.GetMethod(method)!!.Invoke(nil, []object? {argument})
        }

        private func Translate(source string, library MetadataReference, nullable NullableContextOptions) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Adr0186ObliviousReadConsumer",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(library).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(nullable)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func CompileLibrary(assemblyName string) CSharpCompilation -> CSharpCompilation.Create(
            assemblyName,
            []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource, CSharpParseOptions(LanguageVersion.Latest))},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
        )
    }
}
