// <copyright file="OahuDecryptTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit
import Xunit.Sdk

/// Translation tests for the C# surface area exercised by the
/// `Oahu.Decrypt` corpus app (ADR-0115 §B/§G): C# 12 collection
/// expressions, throw-expressions, is-pattern combinators (constant / not / or
/// / and / recursive), range slicing, the null-forgiving operator, embedded
/// post-increment/decrement, `yield break`, field-like events, UTF-8
/// string literals, and `foreach` tuple deconstruction. Every snippet must
/// round-trip-parse through the real G# parser (the translate-stage gate).
open class OahuDecryptTranslationTests {
    /// A C# 12 collection expression `[a, b, c]` targeting an array is
    /// emitted as the canonical G# slice literal `[]T{ … }`; bare numeric
    /// literals are coerced to the element type (ADR-0115 §B).
    @Fact
    func CollectionExpression_TargetingByteArray_EmittedAsSliceLiteral() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static byte[] Make() => [1, 2, 3];
    }
}`)
        Assert.Contains("[]uint8{", printed)
        Assert.Contains("uint8(1)", printed)
        Assert.DoesNotContain("ReportUnsupported", printed)
    }

    /// A C# throw-expression on the right of `??` maps to G#'s native
    /// throw-expression (`s ?? throw …`); G# supports throw-as-expression
    /// directly (issue #1153), so no `if true { … }` lowering is needed.
    @Fact
    func ThrowExpression_InNullCoalescing_RendersNativeCoalesceThrow() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static string Get(string? s) => s ?? throw new System.ArgumentNullException(nameof(s));
    }
}`)
        Assert.Contains("?? throw", printed)
        Assert.DoesNotContain("if true {", printed)
    }

    /// A C# throw-expression in a ternary branch (`cond ? v : throw e`)
    /// becomes a G# if-expression branch. Because gsc rejects a bare throw as the
    /// sole trailing value of an if-expression block branch (GS0277), the printer
    /// emits the throw as a STATEMENT followed by a value-producing typed tail
    /// (`else { throw … default(T) }`) — no `if true { … }` wrapper.
    @Fact
    func ThrowExpression_InTernaryBranch_RendersBlockSafeThrow() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static int Get(System.Collections.Generic.Dictionary<int, int> d, int k)
            => d.TryGetValue(k, out var v) ? v : throw new System.ArgumentOutOfRangeException(nameof(k));
    }
}`)
        Assert.Contains("throw ", printed)
        Assert.DoesNotContain("if true {", printed)
    }

    /// A constant pattern in an `is` expression lowers to an equality test
    /// (`x is 5` → `x == 5`); G# `is` in expression position supports
    /// only `expr is Type` (ADR-0115 §B).
    @Fact
    func ConstantPattern_InIsExpression_LoweredToEquality() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static bool Zero(int x) => x is 0;
    }
}`)
        Assert.Contains("x == 0", printed)
    }

    /// An `or` pattern lowers to a disjunction of equality tests, and a
    /// `not` pattern to a negated test (C# precedence preserved).
    @Fact
    func OrAndNotPatterns_InIsExpression_LoweredToBooleanOps() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static bool OneOrTwo(int x) => x is 1 or 2;

        public static bool NotText(object o) => o is not string;
    }
}`)
        Assert.Contains("x == 1 || x == 2", printed)
        Assert.Contains("!(o is string)", printed)
    }

    /// A range index over a span (`s[a..b]`) lowers to gsc's OWN native
    /// range-index syntax (`recv[start..end]`) — gsc's binder
    /// (`ExpressionBinder.BindRangeSlice`) resolves it directly against
    /// any CLR span-like type with a `Length`+`Slice(int,int)`
    /// shape, so no `.Slice` desugaring is needed here either (issue
    /// #1896).
    @Fact
    func RangeExpression_OverSpan_LoweredToNativeRangeIndex() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static System.Span<byte> Middle(System.Span<byte> s) => s[1..3];

        public static System.Span<byte> Tail(System.Span<byte> s) => s[2..];

        public static System.Span<byte> Head(System.Span<byte> s) => s[..4];
    }
}`)
        Assert.Contains("s[1..3]", printed)
        Assert.Contains("s[2..]", printed)
        Assert.Contains("s[..4]", printed)
        Assert.DoesNotContain(".Slice(", printed)
    }

    /// At a non-null sink, the C# null-forgiving operator `expr!` maps to
    /// G#'s postfix non-null assertion `expr!!` (ADR-0115 §B).
    @Fact
    func SuppressNullableWarning_MapsToNonNullAssertion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static string Unwrap(string? s) => s!;
    }
}`)
        Assert.Contains("s!!", printed)
    }

    /// A null literal remains `nil` at nullable sinks, including the exact
    /// Oahu DownloadCommand dictionary assignment from issue #2647.
    @Fact
    func NullLiteral_AtNullableSinks_NeverGetsNonNullAssertion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Box
    {
        public object? Value { get; set; }
    }

    public static class DownloadCommand
    {
        private static event System.Action Changed;

        private static void Accept(object? value) { }

        public static object? Record(
            System.Collections.Generic.Dictionary<string, object?> response,
            Box box)
        {
            var rows = new System.Collections.Generic.List<
                System.Collections.Generic.IReadOnlyDictionary<string, object?>>();
            rows.Add(new System.Collections.Generic.Dictionary<string, object?>
            {
                ["error"] = null,
            });
            var strict = new System.Collections.Generic.Dictionary<string, object>
            {
                ["bare"] = null,
                ["suppressed"] = (null)!,
            };
            object? local = null;
            local = null;
            box.Value = null;
            response["error"] = null;
            Accept((null)!);
            Changed += null;
            var strictKeys = new System.Collections.Generic.Dictionary<string, string>();
            var missing = strictKeys[null];
            var cast = (string)null;
            System.Func<object> factory = () => null;
            System.Console.WriteLine("".StartsWith(null));
            return null;
        }
    }
}`, "Fixture deliberately places nil at invalid non-null sinks to verify cs2gs never invents non-null assertions.")
        Assert.Contains("[\"error\"] = nil", printed)
        Assert.Contains("response[\"error\"] = nil", printed)
        Assert.Contains("strictKeys[nil]", printed)
        Assert.Contains("StartsWith(nil)", printed)
        Assert.DoesNotContain("default(object)", printed)
        Assert.DoesNotContain("nil!!", printed)
    }

    /// C#'s suppression on a null literal must not manufacture a non-null G#
    /// value. Keeping `nil` lets the target type accept nullable sinks and
    /// reject genuinely non-null sinks.
    @Fact
    func SuppressNullableWarning_OnNullLiteral_PreservesTargetChecking() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Node
    {
        public Node(Node parent) { }
    }

    public class Root : Node
    {
        public Root() : base(null!) { }
    }
}`)
        Assert.Contains("base(nil)", printed)
        Assert.DoesNotContain("default(Node)", printed)
        Assert.DoesNotContain("nil!!", printed)
    }

    /// An embedded post-increment used as an expression (`a[i++] = v`) is
    /// hoisted: the sub-expression reads the pre-increment value and the
    /// mutation is appended as a trailing `i++` statement (ADR-0115 §B).
    @Fact
    func PostIncrement_AsExpression_HoistedToTrailingStatement() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static void Set(int[] a, int i)
        {
            a[i++] = 7;
        }
    }
}`)
        Assert.Contains("a[i] = 7", printed)
        Assert.Contains("i++", printed)
    }

    /// Issue #4114: TWO postfix increments of the SAME target within one
    /// statement (`H(x++), H(x++)`) are NOT both hoisted to trailing
    /// statements. C# sequences them left-to-right — the first call observes
    /// the original value, the second observes it already incremented — and
    /// deferring both mutations to after the whole statement would collapse
    /// that sequencing, so every hoisted read would observe the same
    /// (original) value. This is exactly how the self-hosted compiler's
    /// inherited event-bridge MethodDef row planner (`PlanBridge` in
    /// `InterfaceImplEmitter.cs`) built two numerically identical
    /// planned handles from `H(nextMethodRow++), H(nextMethodRow++)`,
    /// which then tripped its "not emitted in planned order" guard (GS9998)
    /// once self-hosted. The repeated target's occurrences must fall through
    /// to G#'s native inline inc/dec expression instead, which evaluates
    /// each occurrence in true left-to-right order.
    @Fact
    func PostIncrement_SameTargetTwiceInOneStatement_PreservesLeftToRightSequencing() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static void Record(int a, int b) { }

        public static void Pair(int x)
        {
            Record(H(x++), H(x++));
        }

        private static int H(int n) => n;
    }
}`)
        // Neither occurrence may be hoisted to a trailing statement: that
        // would print `x` (a bare read) at BOTH call sites and defer both
        // mutations to the end, losing the first call's distinct
        // pre-increment value. Each call site keeps its own inline `x++`.
        Assert.DoesNotContain("H(x), H(x)", printed)
        Assert.Equal(2, CountOccurrences(printed, "H(x++)"))
    }

    /// Issue #4114 follow-up (Copilot review of PR #4196): an array-element
    /// postfix increment (`a[0]++`) has no target `ISymbol` via
    /// `GetSymbolInfo` — element access is a built-in operation, not a
    /// symbol reference — so aliasing between two occurrences can never be
    /// ruled out. The original fix's `target == null` branch treated an
    /// unresolved target as safely hoistable (mirroring pre-#4114 behavior),
    /// which reintroduces exactly the bug #4114 fixed whenever the repeated
    /// target is unresolvable rather than a plain local: both occurrences of
    /// `a[0]++` would still be independently hoisted, again observing
    /// the same pre-increment value. An unresolved target must now stay
    /// inline unconditionally.
    @Fact
    func PostIncrement_ArrayElementTargetTwiceInOneStatement_PreservesLeftToRightSequencing() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static void Record(int a, int b) { }

        public static void Pair(int[] arr)
        {
            Record(H(arr[0]++), H(arr[0]++));
        }

        private static int H(int n) => n;
    }
}`)
        // Neither occurrence may be hoisted to a trailing statement: an
        // unresolved target (array-element access) can never be proven
        // single-occurrence, so it must stay inline exactly like a repeated
        // resolvable target does.
        Assert.DoesNotContain("H(arr[0]), H(arr[0])", printed)
        Assert.Equal(2, CountOccurrences(printed, "H(arr[0]++)"))
    }

    /// `yield break` maps to G#'s native `yield break` statement
    /// (issue #3501 A1), which terminates the iterator from any depth.
    @Fact
    func YieldBreak_TranslatesNatively() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static System.Collections.Generic.IEnumerable<int> Take(bool stop)
        {
            if (stop)
            {
                yield break;
            }

            yield return 1;
        }
    }
}`)
        Assert.Contains("yield break", printed)
        Assert.DoesNotContain("__iteratorExit", printed)
        Assert.DoesNotContain("goto", printed)
        Assert.DoesNotContain("unsupported", printed)
    }

    /// Issue #3394: iterator accessors and local functions use their own body
    /// as the synthesized `yield break` target.
    @Fact
    func YieldBreak_InGetterAndLocalFunction_UsesMatchingExitLabels() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        private bool stop;

        public System.Collections.Generic.IEnumerable<int> Values
        {
            get
            {
                if (this.stop)
                {
                    yield break;
                }

                yield return 1;
            }
        }

        public System.Collections.Generic.IEnumerable<int> Local()
        {
            System.Collections.Generic.IEnumerable<int> Inner()
            {
                if (this.stop)
                {
                    yield break;
                }

                yield return 2;
            }

            return Inner();
        }
    }
}`)
        let exits = printed
            .Split('\n')
            .Where((line string) -> line.Contains("__iteratorExit", StringComparison.Ordinal))
            .Select(
            (line string) -> {
                let start = line.IndexOf("__iteratorExit", StringComparison.Ordinal)
                var end = start + "__iteratorExit".Length
                while end < line.Length && char.IsDigit(line[end]) {
                    end++
                }
                return line.Substring(start, end - start)
            }
        )
            .ToArray()
        // Issue #3501 A1: `yield break` translates to G#'s native
        // `yield break` — no synthesized exit labels remain.
        Assert.Empty(exits)
        Assert.Equal(
            2,
            printed.Split('\n').Count((line string) -> line.TrimEnd().EndsWith("yield break", StringComparison.Ordinal))
        )
    }

    /// A field-like event maps to the canonical G# `event Name Type`
    /// (name-then-type, no accessor body, nullable annotation dropped).
    @Fact
    func EventField_MappedToEventDeclaration() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public event System.EventHandler<int>? Changed;
    }
}`)
        Assert.Contains("event Changed EventHandler[int32]", printed)
    }

    /// A UTF-8 string literal `""…""u8` maps to a G# byte-slice literal
    /// `[]uint8{ … }` of the UTF-8 bytes (ADR-0115 §B).
    @Fact
    func Utf8StringLiteral_MappedToByteSlice() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static System.ReadOnlySpan<byte> Tag() => "AB"u8;
    }
}`)
        Assert.Contains("[]uint8{", printed)
        Assert.Contains("0x41", printed)
        Assert.Contains("0x42", printed)
    }

    /// A `foreach` over a tuple deconstruction translates directly to G#'s
    /// first-class deconstructing for-in header (`for (a, b) in xs { … }`,
    /// issue #1922) instead of a hidden temp variable plus a separate
    /// `let (a, b) = tmp` statement. The G# two-name `for k, v in xs`
    /// form is index/element iteration, NOT tuple deconstruction (ADR-0115 §B).
    @Fact
    func ForEachVariable_TupleDeconstruction_DeconstructsElementInBody() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static int Sum(System.Collections.Generic.IEnumerable<(int A, int B)> xs)
        {
            int total = 0;
            foreach ((int a, int b) in xs)
            {
                total += a + b;
            }

            return total;
        }
    }
}`)
        Assert.Contains("for (a, b) in xs {", printed)
        Assert.DoesNotContain("__decon", printed)
        Assert.DoesNotContain("for a, b in xs", printed)
    }

    /// A type reference that Roslyn parses as a constant pattern after a pattern
    /// combinator (`is Frame f and not EmptyFrame`) is a type test, not an
    /// equality `x != EmptyFrame` (which would treat the type name as a value
    /// → GS0125). ADR-0166 / issue #3409: the designation `f` qualifies as a
    /// native pattern variable, so the whole pattern — including the
    /// `and not EmptyFrame` type-pattern conjunct — is emitted verbatim.
    @Fact
    func IsPattern_TypeReferenceAfterCombinator_KeepsNativeTypePattern() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Frame { }
    public sealed class EmptyFrame : Frame { }
    public static class C
    {
        public static bool IsRealFrame(object o) => o is Frame f and not EmptyFrame;
    }
}`)
        Assert.Contains("o is Frame f and not EmptyFrame", printed)
        Assert.DoesNotContain("!= EmptyFrame", printed)
        Assert.DoesNotContain("== EmptyFrame", printed)
        Assert.DoesNotContain("as Frame", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    /// A C# `await foreach` over an `IAsyncEnumerable<T>` lowers to
    /// G#'s asynchronous-iteration form `await for x in seq` (spec
    /// AwaitForRangeStmt). A plain `for x in seq` over an async sequence is
    /// rejected by gsc (GS0116 "not indexable").
    @Fact
    func AwaitForeach_LowersToAwaitForLoop() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public async System.Threading.Tasks.Task F(System.Collections.Generic.IAsyncEnumerable<int> src)
        {
            await foreach (var x in src)
            {
                System.Console.WriteLine(x);
            }
        }
    }
}`)
        Assert.Contains("await for x in src", printed)
        Assert.DoesNotMatch("(?<!await )for x in src", printed)
    }

    /// A non-async `foreach` still lowers to a plain `for x in seq`
    /// (no spurious `await`).
    @Fact
    func Foreach_NonAsync_LowersToPlainForLoop() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void F(System.Collections.Generic.IEnumerable<int> src)
        {
            foreach (var x in src)
            {
                System.Console.WriteLine(x);
            }
        }
    }
}`)
        Assert.Contains("for x in src", printed)
        Assert.DoesNotContain("await for", printed)
    }

    /// A control character inside a string literal (here NUL from C# `\0`)
    /// is re-escaped as a `\uXXXX` escape so the emitted G# string stays
    /// terminated and round-trips (ADR-0115 §B).
    @Fact
    func StringLiteral_WithControlCharacter_EscapedAsUnicode() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class C
    {
        public static string Nulls() => "\0\0\0";
    }
}`)
        Assert.Contains("\\u0000", printed)
    }

    /// A generic call chained after a null-conditional `?.`
    /// (`t.GetChild<MdiaBox>()?.GetChild<HdlrBox>()`) must keep
    /// its type arguments on every link of the chain, not just the first
    /// (ADR-0115 §B). The member-binding after `?.` carries a
    /// `GenericNameSyntax` whose type-argument list must be lifted onto the
    /// G# bracket form, otherwise the chained call loses `[T…]` and binds to
    /// the wrong (or no) overload.
    @Fact
    func NullConditionalChainedGenericCall_PreservesTypeArguments() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class HdlrBox { public string HandlerType => "soun"; }
    public class MdiaBox { public T GetChild<T>() => default; }
    public class TrakBox { public T GetChild<T>() => default; }
    public static class C
    {
        public static string Handler(TrakBox t) =>
            t.GetChild<MdiaBox>()?.GetChild<HdlrBox>()?.HandlerType;
    }
}`)
        Assert.Contains("t.GetChild[MdiaBox]()?.GetChild[HdlrBox]()?.HandlerType", printed)
        Assert.DoesNotContain("?.GetChild()", printed)
    }

    /// A reference to a nested BCL type
    /// (`ConfiguredTaskAwaitable.ConfiguredTaskAwaiter`) must be qualified
    /// with its containing type (ADR-0115 §B.12). Emitting the innermost name
    /// alone produces an unresolvable `ConfiguredTaskAwaiter` (GS0113).
    @Fact
    func NestedBclType_QualifiedWithContainingType() {
        let printed = TranslateUnit(`
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
namespace Demo
{
    public class C
    {
        public ConfiguredTaskAwaitable.ConfiguredTaskAwaiter Awaiter(Task t) =>
            t.ConfigureAwait(false).GetAwaiter();
    }
}`)
        Assert.Contains("ConfiguredTaskAwaitable.ConfiguredTaskAwaiter", printed)
    }

    /// Issue #3357: enum extensions use the explicit receiver-clause form and
    /// retain member-call syntax.
    @Fact
    func EnumExtensionMethod_UsesExplicitReceiverAndMemberCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public enum ChannelGroups { Mono, Stereo }
    public static class Ac4Extensions
    {
        public static int ChannelCount(this ChannelGroups channels) =>
            channels == ChannelGroups.Stereo ? 2 : 1;
    }
    public class User
    {
        public int Use(ChannelGroups g) => g.ChannelCount();
    }
}`)
        Assert.Contains("func (channels ChannelGroups) ChannelCount() int32", printed)
        Assert.Contains("g.ChannelCount()", printed)
        Assert.DoesNotContain("Ac4Extensions.ChannelCount(g)", printed)
    }

    /// Defect #914-1: a parameterless-constructor assignment whose right-hand side
    /// reads an instance member (here the abstract instance property
    /// `InputBufferSize`) must NOT be hoisted into a G# field initializer — a
    /// field initializer cannot reference instance state (GS0125). Issue #2746
    /// keeps the entire explicit class constructor, preserving both assignments'
    /// order and the fields' visibility.
    @Fact
    func CtorAssignment_ReferencingInstanceMember_StaysInInitBody() {
        let printed = TranslateUnit(`
namespace Demo
{
    public abstract class FrameFilterBase<TInput>
    {
        private readonly int[] cache;
        private TInput[] buffer;

        public FrameFilterBase()
        {
            cache = new int[8];
            buffer = new TInput[InputBufferSize];
        }

        protected abstract int InputBufferSize { get; }
    }
}`)
        // The instance-member-dependent assignment is kept in an init() body.
        Assert.Contains("init()", printed)
        Assert.Contains("cache = [8]int32", printed)
        Assert.Contains("buffer = [InputBufferSize]TInput", printed)
        // The field itself carries no (invalid) hoisted initializer. Issue #4684: the
        // only initializer it may carry is the allocation-free `Array.Empty` one that
        // replaces gsc's synthesized zero-value array.
        AssertArrayFieldInitializer(printed, "var buffer []TInput", "TInput")
        // The static-RHS sibling remains in the same explicit constructor.
        AssertArrayFieldInitializer(printed, "let cache []int32", "int32")
    }

    @Theory
    @InlineData("SomeCall()")
    @InlineData("System.Array.Empty[int32]()")
    @InlineData("System.Array.Empty[TInput](1)")
    @InlineData("[8]TInput")
    @InlineData("[]TInput{}")
    func CtorAssignment_ArrayFieldInitializerOracleRejectsOtherInitializers(initializer string) {
        Assert.Throws[TrueException](
            () -> AssertArrayFieldInitializer(
                "private var buffer []TInput = " + initializer,
                "var buffer []TInput",
                "TInput"
            )
        )
    }

    @Theory
    @InlineData("private var buffer []TInput")
    @InlineData("private var buffer []TInput = System.Array.Empty[TInput]()")
    func CtorAssignment_ArrayFieldInitializerOracleAcceptsOnlyPermittedForms(declaration string) {
        AssertArrayFieldInitializer(declaration, "var buffer []TInput", "TInput")
    }

    /// Defect #914-2: a C# iterator method declared to return
    /// `IEnumerator<T>` maps to the G# return type
    /// `IEnumerator[T]` (NOT `sequence[T]`), so it satisfies
    /// `IEnumerable[T].GetEnumerator`. The explicit non-generic
    /// `IEnumerable.GetEnumerator` keeps its qualifier so imported metadata
    /// never contains a return-type-only public overload pair (issue #2822).
    /// A method returning `IEnumerable<T>` still maps to
    /// `sequence[T]`.
    @Fact
    func IteratorReturningIEnumeratorOfT_MapsToIEnumeratorOfT() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections;
    using System.Collections.Generic;

    public class Repo<T> : IEnumerable<T>
    {
        private readonly List<T> items = new List<T>();

        public IEnumerator<T> GetEnumerator()
        {
            foreach (var x in items) { yield return x; }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        public IEnumerable<T> All()
        {
            foreach (var x in items) { yield return x; }
        }
    }
}`)
        // The IEnumerator<T> iterator keeps the IEnumerator[T] return type.
        Assert.Contains("func GetEnumerator() IEnumerator[T]", printed)
        Assert.DoesNotContain("func GetEnumerator() sequence[T]", printed)
        // The non-generic explicit implementation keeps its qualifier and
        // C#-faithful private visibility.
        Assert.Contains("private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()", printed)
        Assert.DoesNotContain("${Environment.NewLine}    func GetEnumerator() IEnumerator ->", printed)
        // The IEnumerable<T> generator still lowers to sequence[T].
        Assert.Contains("func All() sequence[T]", printed)
        AssertGscCompiles(printed)
    }

    /// Issue #3814: an explicit implementation of an IMPORTED GENERIC
    /// interface's member keeps its ADR-0149 clause and its C#-faithful private
    /// visibility. This case used to fall back to the #1911 named/forced-public
    /// path because gsc erased the clause's type arguments while resolving the
    /// CLR slot (GS0494); it now resolves the slot through the interface's open
    /// definition with the symbolic arguments substituted, so the fallback — and
    /// the duplicate-overload collisions it caused for a type implementing TWO
    /// instantiations — is gone.
    @Fact
    func GenericImportedExplicitInterfaceQualifier_KeepsClauseAndCompiles() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;

    public class Value<T> : IEquatable<T>
    {
        bool IEquatable<T>.Equals(T other) => true;
    }
}`)
        Assert.Contains("private func (IEquatable[T]) Equals(other T) bool -> true", printed)
        AssertGscCompiles(printed)
    }

    /// Issue #3814: the shape that walled `test/Core.Tests` — one member
    /// explicitly implemented on TWO instantiations of the same imported generic
    /// interface. Dropping the clause made the two methods differ only in return
    /// type, i.e. a duplicate overload (GS0264) plus an unimplemented interface
    /// (GS0187). Both clauses must now survive.
    @Fact
    func TwoInstantiationsOfOneImportedGenericInterface_KeepBothClauses() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections;
    using System.Collections.Generic;

    public sealed class Conflict : IReadOnlyCollection<int>, IReadOnlyCollection<string>
    {
        public int Count => 0;

        IEnumerator<int> IEnumerable<int>.GetEnumerator() => new List<int>().GetEnumerator();

        IEnumerator<string> IEnumerable<string>.GetEnumerator() => new List<string>().GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => new List<int>().GetEnumerator();
    }
}`)
        Assert.Contains("(IEnumerable[int32]) GetEnumerator() IEnumerator[int32]", printed)
        Assert.Contains("(IEnumerable[string]) GetEnumerator() IEnumerator[string]", printed)
        Assert.Contains("(IEnumerable) GetEnumerator() IEnumerator", printed)
        AssertGscCompiles(printed)
    }

    /// Defect #914-3: a C# binary expression that relied on implicit numeric
    /// promotion across differing operand types (here `ushort? == int`) must
    /// emit an explicit conversion so both operands share a G# type — G# has no
    /// implicit cross-type numeric promotion (GS0129). The constant literal is
    /// retyped to the other operand's G# type.
    @Fact
    func BinaryExpression_ImplicitNumericPromotion_MadeExplicit() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Entry { public ushort ChannelCount { get; set; } }

    public class C
    {
        public bool IsStereo(Entry? e) => e?.ChannelCount == 2;
    }
}`)
        Assert.Contains("== (2 as uint16?)", printed)
    }

    /// Defect #914-3 guard: when the operands already share an underlying numeric
    /// type (only nullability differs, e.g. `int? == int`), no conversion is
    /// inserted — that form already compiles and must not be perturbed.
    @Fact
    func BinaryExpression_SameUnderlyingNumericType_NotPerturbed() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Entry { public int Count { get; set; } }

    public class C
    {
        public bool IsTwo(Entry? e) => e?.Count == 2;
    }
}`)
        Assert.Contains("Count == 2", printed)
        Assert.DoesNotContain(" as int32", printed)
    }

    /// Oahu.Decrypt's `Artist?.Split(';')?[0]` uses a second safe index
    /// even though `String.Split` returns a non-null array. Keep null
    /// propagation from `Artist`, but render the dependent index as ordinary
    /// `[0]`; a genuinely nullable chain result must retain `?[0]`.
    @Fact
    func NullConditionalIndex_UsesImmediateChainResultNullability() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Provider
    {
        public string[]? Items { get; set; }
        public string[]? MaybeItems() => null;
        public ValueProvider? MaybeValue { get; set; }
        public ValueProvider? MaybeValueResult() => null;

        public string[]? this[int index] => null;
    }

    public readonly struct ValueProvider
    {
        public string[] this[int index] => System.Array.Empty<string>();
    }

    public class MetadataItems
    {
        public string? Artist { get; set; }
        public Provider? Provider { get; set; }

        public string? FirstAuthor => Artist?.Split(';')?[0];
        public string? MaybeFirst => Provider?.MaybeItems()?[0];
        public string? MaybeMember(Provider? p) => p?.Items?[0];
        public string? MaybeIndexer(Provider? p) => p?[0]?[0];
        public string[]? NullableValueProperty(Provider? p) => p?.MaybeValue?[5];
        public string[]? NullableValueMethod(Provider? p) => p?.MaybeValueResult()?[6];

        public string? FlowNarrowedMember(Provider p)
        {
            if (p.Items is null)
            {
                return null;
            }

            return p?.Items?[0];
        }
    }
}`)
        Assert.Contains("Artist?.Split(';')[0]", printed)
        Assert.DoesNotContain("Artist?.Split(';')?[0]", printed)
        Assert.Contains("Provider?.MaybeItems()?[0]", printed)
        Assert.Contains("p?.Items?[0]", printed)
        Assert.Contains("p?[0]?[0]", printed)
        Assert.Contains("p?.MaybeValue?[5]", printed)
        Assert.Contains("p?.MaybeValueResult()?[6]", printed)
        Assert.Contains("return p?.Items?[0]", printed)
        AssertGscCompiles(printed, "GS0300")
    }

    @Fact
    func NullConditionalIndex_PreservesLiftedReceiverNullPropagation() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class ClassProvider
    {
        public string[] Items => System.Array.Empty<string>();
        public string[] this[int index] => System.Array.Empty<string>();
    }

    public readonly struct ValueProvider
    {
        public string[] this[int index] => System.Array.Empty<string>();
    }

    public class C
    {
        public string? ClassReceiver(ClassProvider? p) => p?[1]?[2];
        public string? ValueReceiver(ValueProvider? p) => p?[3]?[4];
    }
}`)
        Assert.Contains("p?[1]?[2]", printed)
        Assert.Contains("p?[3]?[4]", printed)
        Assert.DoesNotContain("!!", printed)
        AssertGscCompiles(printed, "GS0300")
    }

    @Fact
    func NullConditionalIndex_RetainsSafeIndexForPromotedMemberBindings() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Provider
    {
        public string[] FieldItems = System.Array.Empty<string>();
        public string[] PropertyItems { get; set; } = System.Array.Empty<string>();

        public void Clear()
        {
            FieldItems = null;
            PropertyItems = null;
        }
    }

    public class C
    {
        public string Field(Provider p) => p?.FieldItems?[0];
        public string Property(Provider p) => p?.PropertyItems?[0];
    }
}`)
        Assert.Contains("p?.FieldItems?[0]", printed)
        Assert.Contains("p?.PropertyItems?[0]", printed)
        AssertGscCompiles(printed, "GS0300")
    }

    /// A tuple literal element keeps the bare local when G#'s own flow analysis
    /// carries the preceding non-null guard into the tuple value.
    @Fact
    func TupleLiteralElement_GuardedNullable_UsesGSharpSmartCast() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Inner { }

    public class C
    {
        public (Inner, int) M(Inner? a)
        {
            if (a is null) throw new System.InvalidOperationException();
            return (a, 1);
        }
    }
}`)
        Assert.Contains("return (a,", printed)
        Assert.DoesNotContain("a!!", printed)
    }

    shared {
        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var index = 0
            while (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += value.Length
            }
            return count
        }

        private func AssertArrayFieldInitializer(printed string, declaration string, elementType string) {
            let line = Assert.Single(
                printed.Split('\n'),
                (line string) -> line.Contains(declaration, StringComparison.Ordinal)
            )
                .Trim()
            Assert.True(
                line == "private " + declaration || line == "private $declaration = System.Array.Empty[$elementType]()",
                "Expected no initializer or a correctly typed, argument-free Array.Empty call, got: " + line
            )
        }

        private func TranslateUnit(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func AssertGscCompiles(source string, forbiddenDiagnostics ...string) {
            let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory) ?? GscInvoker.Resolve(
                nil,
                "Debug",
                AppContext.BaseDirectory
            )
            Assert.NotNull(compiler)
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "compile-tests",
                "issue2822",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "translated.gs")
                File.WriteAllText(sourcePath, source)
                let result = GscInvoker(compiler!!).Compile(
                    []string{sourcePath},
                    Path.Combine(directory, "translated.dll"),
                    TargetKind.Library,
                    Array.Empty[string]()
                )
                Assert.True(result.Succeeded, result.Output)
                for diagnostic in forbiddenDiagnostics {
                    Assert.DoesNotContain(diagnostic, result.Output)
                }
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}
