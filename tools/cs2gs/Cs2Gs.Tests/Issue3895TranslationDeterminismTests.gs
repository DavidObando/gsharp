// <copyright file="Issue3895TranslationDeterminismTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.CompilerServices
import Xunit

/// Issue #3895: the corpus-wide `!!` count is a tracked #3501 gate metric
/// (`nullAssertionCeiling`), and every ratchet decision assumes it is a
/// FUNCTION OF THE INPUT. These tests pin that assumption where it is cheap to
/// pin it: identical input must produce byte-identical G#, and the
/// null-forgiveness decision must not depend on the order in which the
/// compilation's syntax trees are visited.
///
/// The order-invariance half is the one with teeth. The oblivious-nullability
/// taint analysis is a fixpoint over an edge set collected in ONE pass over
/// `compilation.SyntaxTrees`; if any part of that collection ever starts
/// reading the partially-built taint set, or if the propagation loop stops
/// being monotone, the answer silently becomes a function of tree order — and
/// tree order is set by MSBuild's `Compile` item list, which is an
/// implementation detail no ratchet should depend on. Reversing the trees is a
/// cheap, deterministic stand-in for "some other order".
///
/// WHAT THESE TESTS DO NOT COVER. Both passes run in ONE process, so neither
/// can observe a dependence on .NET's per-process string hash seed, on
/// filesystem enumeration order, or on GC timing evicting a
/// `ConditionalWeakTable` entry. A whole-corpus repeat run is the only
/// thing that covers those, and issue #3895 records five of them.
open class Issue3895TranslationDeterminismTests {
    /// Two independent translations of identical input must agree byte for
    /// byte — not merely in their `!!` COUNT, which a compensating pair
    /// of moves would keep constant.
    @Fact
    func TranslatingTheSameSourcesTwice_ProducesByteIdenticalOutput() {
        let first = TranslateAll(Sources)
        let second = TranslateAll(Sources)
        AssertEmitsAssertions(first)
        AssertSameOutput(first, second, "a second translation of identical input")
    }

    /// Reversing the compilation's syntax-tree order must not move a single
    /// character of any file's output. Each document is translated on its own,
    /// so its text is a function of that document plus whole-program facts; a
    /// whole-program fact that changed with visit order would be a
    /// non-converged fixpoint, not a formatting difference.
    @Fact
    func ReversingSyntaxTreeOrder_ProducesTheSamePerDocumentOutput() {
        let forward = TranslateAll(Sources)
        let reversed = TranslateAll(Sources.Reverse().ToArray())
        AssertEmitsAssertions(forward)
        AssertSameOutput(forward, reversed, "a reversed syntax-tree order")
    }

    /// The nullable TYPE decisions the same fixpoint drives, asserted
    /// independently of the assertion sites: a declaration that renders
    /// `T?` under one tree order must render `T?` under the other.
    /// A promotion that flipped would move every downstream `!!` with it.
    @Fact
    func NullablePromotions_AreInvariantUnderSyntaxTreeOrder() {
        let forward = TranslateAll(Sources)
        let reversed = TranslateAll(Sources.Reverse().ToArray())
        // Anti-vacuity: the fixture must actually promote something, or the
        // comparison below compares two promotion-free trees.
        Assert.Contains(
            forward,
            (entry KeyValuePair[string, string]) -> entry.Value.Contains("?", StringComparison.Ordinal)
        )
        for entry in forward {
            Assert.Equal(CountOccurrences(entry.Value, "?"), CountOccurrences(reversed[entry.Key], "?"))
            Assert.Equal(CountOccurrences(entry.Value, "!!"), CountOccurrences(reversed[entry.Key], "!!"))
        }
    }

    /// Issue #4610: same-named lifted local-function helpers across partial
    /// documents must receive identical suffixes regardless of syntax-tree
    /// visitation order.
    @Fact
    func PartialTypeLiftedLocalFunctionSuffixes_AreInvariantUnderSyntaxTreeOrder() {
        let partialSources = [](FileName string, Source string){("Widget.First.cs", `
namespace Demo
{
    public partial class Widget
    {
        public int First(int value)
        {
            return Step(value);
            static int Step(int n) => n == 0 ? 10 : Peer<int>(n - 1);
            static int Peer<T>(int n) => Step(n);
        }
    }
}`), ("Widget.Second.cs", `
namespace Demo
{
    public partial class Widget
    {
        public int Second(int value)
        {
            return Step(value);
            static int Step(int n) => n == 0 ? 20 : Peer<int>(n - 1);
            static int Peer<T>(int n) => Step(n);
        }
    }
}`)}
        let forward = TranslateAll(partialSources)
        let reversed = TranslateAll(partialSources.Reverse().ToArray())
        Assert.Contains("func Step(", forward["Widget.First.cs"], StringComparison.Ordinal)
        Assert.Contains("func Step_2(", forward["Widget.Second.cs"], StringComparison.Ordinal)
        AssertSameOutput(forward, reversed, "a reversed partial-type syntax-tree order")
    }

    /// Issue #4610 (review): preallocating lifted local functions across partial
    /// documents must not corrupt in-block mutual-recursion local-function groups,
    /// lowered get-only property backing fields must reserve primary-constructor
    /// parameter names declared in any partial part, and synthesized iterator
    /// locals (`item`) and asymmetric document imports (`System.Collections.Generic.Comparer`)
    /// must not make helper suffix assignment depend on syntax-tree visitation order.
    @Fact
    func PartialTypeMutualRecursionAndPrimaryCtorBackingField_AreInvariantUnderSyntaxTreeOrder() {
        let partialSources = [](FileName string, Source string){("Holder.Empty.cs", `
using System.Collections.Generic;
using @class;

namespace @class
{
    public class Step
    {
    }
}

namespace Demo
{
    public class StringBuilder
    {
    }

    public class Other
    {
        public virtual int Value { get; } = 1;
        public virtual int Own { get; } = 1;
        public string Make() => new System.Text.StringBuilder().Append("x").ToString();
    }

    public partial class Holder
    {
        public int Mutual(int limit)
        {
            int offset = 1;
            return Even(limit);
            int Even(int n) => n <= 0 ? offset : Odd(n - 1);
            int Odd(int n) => Even(n - 1);
        }

        public IEnumerable<int> Items(bool flag)
        {
            yield return flag ? 1 : 2;
        }
    }
}`), ("Holder.Primary.cs", `
namespace Demo
{
    public partial class Holder(int _value, System.Text.StringBuilder builder)
    {
        public virtual int Value { get; } = _value * 2;
        public virtual int Own { get; } = 3;
        public string Format() => builder.Append("y").ToString();

        public int Lifted(int value)
        {
            return item(value) + Comparer(value) + Step(value) + TextStringBuilder(value);
            static int item(int n) => n == 0 ? 10 : Peer<int>(n - 1);
            static int Peer<T>(int n) => item(n);
            static int Comparer(int n) => n == 0 ? 20 : ComparerPeer<int>(n - 1);
            static int ComparerPeer<T>(int n) => Comparer(n);
            static int Step(int n) => n == 0 ? 30 : StepPeer<int>(n - 1);
            static int StepPeer<T>(int n) => Step(n);
            static int TextStringBuilder(int n) => n == 0 ? 40 : BuilderPeer<int>(n - 1);
            static int BuilderPeer<T>(int n) => TextStringBuilder(n);
        }
    }
}`), ("Holder.Third.cs", `
namespace Demo
{
    public class NonPartialPeer
    {
        public int Run(int value)
        {
            return TextStringBuilder_2(value);
            static int TextStringBuilder_2(int n) => n == 0 ? 50 : Peer<int>(n - 1);
            static int Peer<T>(int n) => TextStringBuilder_2(n);
            static int Comparer(int n) => n == 0 ? 60 : ComparerPeer<int>(n - 1);
            static int ComparerPeer<T>(int n) => Comparer(n);
        }
    }
}`)}
        let forward = TranslateAll(partialSources)
        let reversed = TranslateAll(partialSources.Reverse().ToArray())
        Assert.Contains("_value2", forward["Holder.Primary.cs"], StringComparison.Ordinal)
        Assert.Contains("_own", forward["Holder.Primary.cs"], StringComparison.Ordinal)
        Assert.DoesNotContain("_own2", forward["Holder.Primary.cs"], StringComparison.Ordinal)
        Assert.Contains("func item(", forward["Holder.Primary.cs"], StringComparison.Ordinal)
        Assert.Contains("let item_2 int32 =", forward["Holder.Empty.cs"], StringComparison.Ordinal)
        Assert.Contains("func Comparer_2(", forward["Holder.Primary.cs"], StringComparison.Ordinal)
        Assert.Contains("func Step_2(", forward["Holder.Primary.cs"], StringComparison.Ordinal)
        Assert.Contains("func TextStringBuilder(", forward["Holder.Primary.cs"], StringComparison.Ordinal)
        Assert.Contains("func TextStringBuilder_2(", forward["Holder.Third.cs"], StringComparison.Ordinal)
        Assert.Contains("func Comparer(", forward["Holder.Third.cs"], StringComparison.Ordinal)
        Assert.DoesNotContain("func Comparer_2(", forward["Holder.Third.cs"], StringComparison.Ordinal)
        Assert.Contains(
            "import TextStringBuilder_3 = System.Text.StringBuilder",
            forward["Holder.Empty.cs"],
            StringComparison.Ordinal
        )
        Assert.Contains(
            "import TextStringBuilder_3 = System.Text.StringBuilder",
            forward["Holder.Primary.cs"],
            StringComparison.Ordinal
        )
        Assert.DoesNotContain(
            "import System.Collections.Generic",
            forward["Holder.Primary.cs"],
            StringComparison.Ordinal
        )
        AssertSameOutput(forward, reversed, "a reversed partial-type syntax-tree order")
    }

    /// Issue #4667: `IsAnalyzerTargetType` excludes compiler-generated and `<...>` host types.
    @Fact
    func AnalyzerTargetTypeFilter_ExcludesCompilerGeneratedAndAngleBracketTypes() {
        Assert.True(CSharpTypeMapper.IsAnalyzerTargetType(typeof(GSharp.Core.CodeAnalysis.Diagnostic)))
        let salt = 1
        let closure Func[int32, int32] = (x int32) -> x + salt
        let closureDisplayType = closure.Method.DeclaringType!!
        Assert.False(CSharpTypeMapper.IsAnalyzerTargetType(closureDisplayType))
        let testProgramHost = typeof(Issue3895TranslationDeterminismTests).Assembly.GetType("<Program>")
        if testProgramHost != nil {
            Assert.False(CSharpTypeMapper.IsAnalyzerTargetType(testProgramHost))
        }
        let allTypes = typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.GetTypes()
        let included = allTypes.Where(CSharpTypeMapper.IsAnalyzerTargetType).ToArray()
        Assert.NotEmpty(included)
        Assert.All(
            included,
            (t Type) -> {
                Assert.DoesNotContain("<", t.Name, StringComparison.Ordinal)
                Assert.False(t.IsDefined(typeof(CompilerGeneratedAttribute), inherit: false))
            }
        )
    }

    /// Issue #4683: extension call on a constructed generic value (`new ReceiveResult<T>(value, ok).ToTuple()`)
    /// translates and binds cleanly in both instance and static-extension invocation forms.
    @Fact
    func ExtensionCallOnConstructedGenericValue_TranslatesAndBinds() {
        let sources = [](FileName string, Source string){("ChannelOps.cs", `
namespace Gsharp.Concurrency
{
    public readonly struct ReceiveResult<T>
    {
        public T Element { get; }
        public bool Ok { get; }

        public ReceiveResult(T value, bool ok)
        {
            Element = value;
            Ok = ok;
        }
    }

    public static class ChannelOps
    {
        public static (T Value, bool Ok) ViaInstance<T>(T value, bool ok)
        {
            return new ReceiveResult<T>(value, ok).ToTuple();
        }

        public static (T Value, bool Ok) ViaStatic<T>(T value, bool ok)
        {
            return ToTuple(new ReceiveResult<T>(value, ok));
        }

        private static (T Value, bool Ok) ToTuple<T>(this ReceiveResult<T> result) =>
            (result.Element, result.Ok);
    }
}`)}
        let translated = TranslateAll(sources)["ChannelOps.cs"]
        Assert.Contains("ReceiveResult[T](value, ok).ToTuple()", translated, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(translated)
    }

    shared {
        // Deliberately NOT `#nullable enable`: the oblivious-nullability taint
        // analysis — the thing that decides where `!!` lands — only runs on a
        // compilation whose nullable context is disabled, which is the default for
        // an in-memory load and is what the migration corpus mostly looks like.
        private let Sources[](FileName string, Source string) = [](FileName string, Source string){("Model.cs", `
namespace Demo
{
    public class Node
    {
        public string Name;
        public Node Parent;

        public static Node Find(string key)
        {
            return null;
        }

        public string Describe()
        {
            return null;
        }
    }
}`), ("Consumer.cs", `
namespace Demo
{
    public class Consumer
    {
        public int NameLength(string key)
        {
            Node node = Node.Find(key);
            return node.Name.Length;
        }

        public string ParentName(Node node)
        {
            return node.Parent.Name;
        }

        public string Description(Node node)
        {
            return node.Describe().Trim();
        }
    }
}`), ("Relay.cs", `
namespace Demo
{
    public class Relay
    {
        private Node cached;

        public Node Cached
        {
            get { return this.cached; }
        }

        public string Relayed(string key)
        {
            this.cached = Node.Find(key);
            return this.cached.Describe();
        }
    }
}`)}

        private func CountOccurrences(text string, needle string) int32 {
            var count = 0
            var index = 0
            while true {
                index = text.IndexOf(needle, index, StringComparison.Ordinal)
                if index < 0 {
                    return count
                }
                count++
                index += needle.Length
            }
        }

        private func AssertEmitsAssertions(printed IReadOnlyDictionary[string, string]) {
            // Anti-vacuity guard: if the fixture ever stops emitting `!!`, these
            // tests would keep passing while covering nothing this issue is about.
            Assert.Contains(
                printed,
                (entry KeyValuePair[string, string]) -> entry.Value.Contains("!!", StringComparison.Ordinal)
            )
        }

        private func AssertSameOutput(
            expected IReadOnlyDictionary[string, string],
            actual IReadOnlyDictionary[string, string],
            what string
        ) {
            Assert.Equal(
                expected.Keys.OrderBy((k string) -> k, StringComparer.Ordinal),
                actual.Keys.OrderBy((k string) -> k, StringComparer.Ordinal)
            )
            for entry in expected {
                let other = actual[entry.Key]
                Assert.True(
                    string.Equals(entry.Value, other, StringComparison.Ordinal),
                    ("${entry.Key}" + ` translated differently under ` + "$what" + `.
--- first ---
` + "${entry.Value}" + `
--- second ---
` + "$other")
                )
            }
        }

        private func TranslateAll(sources IReadOnlyList[(FileName string, Source string)]) IReadOnlyDictionary[
            string,
            string
        ] {
            let project = LoadBound(sources)
            let printed = Dictionary[string, string](StringComparer.Ordinal)
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
                printed[Path.GetFileName(document.FilePath)] = GSharpPrinter.Print(unit)
            }
            return printed
        }

        private func LoadBound(sources IReadOnlyList[(FileName string, Source string)]) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(
                project.BoundWithoutErrors,
                "Fixture should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            return project
        }
    }
}
