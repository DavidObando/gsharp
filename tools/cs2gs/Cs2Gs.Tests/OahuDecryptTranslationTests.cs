// <copyright file="OahuDecryptTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translation tests for the C# surface area exercised by the
/// <c>Oahu.Decrypt</c> corpus app (ADR-0115 §B/§G): C# 12 collection
/// expressions, throw-expressions, is-pattern combinators (constant / not / or
/// / and / recursive), range slicing, the null-forgiving operator, embedded
/// post-increment/decrement, <c>yield break</c>, field-like events, UTF-8
/// string literals, and <c>foreach</c> tuple deconstruction. Every snippet must
/// round-trip-parse through the real G# parser (the translate-stage gate).
/// </summary>
public class OahuDecryptTranslationTests
{
    /// <summary>
    /// A C# 12 collection expression <c>[a, b, c]</c> targeting an array is
    /// emitted as the canonical G# slice literal <c>[]T{ … }</c>; bare numeric
    /// literals are coerced to the element type (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void CollectionExpression_TargetingByteArray_EmittedAsSliceLiteral()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static byte[] Make() => [1, 2, 3];
    }
}");

        Assert.Contains("[]uint8{", printed);
        Assert.Contains("uint8(1)", printed);
        Assert.DoesNotContain("ReportUnsupported", printed);
    }

    /// <summary>
    /// A C# throw-expression on the right of <c>??</c> maps to G#'s native
    /// throw-expression (<c>s ?? throw …</c>); G# supports throw-as-expression
    /// directly (issue #1153), so no <c>if true { … }</c> lowering is needed.
    /// </summary>
    [Fact]
    public void ThrowExpression_InNullCoalescing_RendersNativeCoalesceThrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static string Get(string? s) => s ?? throw new System.ArgumentNullException(nameof(s));
    }
}");

        Assert.Contains("?? throw", printed);
        Assert.DoesNotContain("if true {", printed);
    }

    /// <summary>
    /// A C# throw-expression in a ternary branch (<c>cond ? v : throw e</c>)
    /// becomes a G# if-expression branch. Because gsc rejects a bare throw as the
    /// sole trailing value of an if-expression block branch (GS0277), the printer
    /// emits the throw as a STATEMENT followed by a value-producing typed tail
    /// (<c>else { throw … default(T) }</c>) — no <c>if true { … }</c> wrapper.
    /// </summary>
    [Fact]
    public void ThrowExpression_InTernaryBranch_RendersBlockSafeThrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static int Get(System.Collections.Generic.Dictionary<int, int> d, int k)
            => d.TryGetValue(k, out var v) ? v : throw new System.ArgumentOutOfRangeException(nameof(k));
    }
}");

        Assert.Contains("throw ", printed);
        Assert.DoesNotContain("if true {", printed);
    }

    /// <summary>
    /// A constant pattern in an <c>is</c> expression lowers to an equality test
    /// (<c>x is 5</c> → <c>x == 5</c>); G# `is` in expression position supports
    /// only <c>expr is Type</c> (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void ConstantPattern_InIsExpression_LoweredToEquality()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static bool Zero(int x) => x is 0;
    }
}");

        Assert.Contains("x == 0", printed);
    }

    /// <summary>
    /// An <c>or</c> pattern lowers to a disjunction of equality tests, and a
    /// <c>not</c> pattern to a negated test (C# precedence preserved).
    /// </summary>
    [Fact]
    public void OrAndNotPatterns_InIsExpression_LoweredToBooleanOps()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static bool OneOrTwo(int x) => x is 1 or 2;

        public static bool NotText(object o) => o is not string;
    }
}");

        Assert.Contains("x == 1 || x == 2", printed);
        Assert.Contains("!(o is string)", printed);
    }

    /// <summary>
    /// A range index over a span (<c>s[a..b]</c>) lowers to gsc's OWN native
    /// range-index syntax (<c>recv[start..end]</c>) — gsc's binder
    /// (<c>ExpressionBinder.BindRangeSlice</c>) resolves it directly against
    /// any CLR span-like type with a <c>Length</c>+<c>Slice(int,int)</c>
    /// shape, so no <c>.Slice</c> desugaring is needed here either (issue
    /// #1896).
    /// </summary>
    [Fact]
    public void RangeExpression_OverSpan_LoweredToNativeRangeIndex()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static System.Span<byte> Middle(System.Span<byte> s) => s[1..3];

        public static System.Span<byte> Tail(System.Span<byte> s) => s[2..];

        public static System.Span<byte> Head(System.Span<byte> s) => s[..4];
    }
}");

        Assert.Contains("s[1..3]", printed);
        Assert.Contains("s[2..]", printed);
        Assert.Contains("s[..4]", printed);
        Assert.DoesNotContain(".Slice(", printed);
    }

    /// <summary>
    /// The C# null-forgiving operator <c>expr!</c> maps to G#'s postfix non-null
    /// assertion <c>expr!!</c> (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void SuppressNullableWarning_MapsToNonNullAssertion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static string Unwrap(string? s) => s!;
    }
}");

        Assert.Contains("s!!", printed);
    }

    /// <summary>
    /// A null literal remains <c>nil</c> at nullable sinks, including the exact
    /// Oahu DownloadCommand dictionary assignment from issue #2647.
    /// </summary>
    [Fact]
    public void NullLiteral_AtNullableSinks_NeverGetsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
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
                [""error""] = null,
            });
            var strict = new System.Collections.Generic.Dictionary<string, object>
            {
                [""bare""] = null,
                [""suppressed""] = (null)!,
            };
            object? local = null;
            local = null;
            box.Value = null;
            response[""error""] = null;
            Accept((null)!);
            Changed += null;
            var strictKeys = new System.Collections.Generic.Dictionary<string, string>();
            var missing = strictKeys[null];
            var cast = (string)null;
            System.Func<object> factory = () => null;
            System.Console.WriteLine("""".StartsWith(null));
            return null;
        }
    }
}",
            "Fixture deliberately places nil at invalid non-null sinks to verify cs2gs never invents non-null assertions.");

        Assert.Contains("[\"error\"] = nil", printed);
        Assert.Contains("response[\"error\"] = nil", printed);
        Assert.Contains("strictKeys[nil]", printed);
        Assert.Contains("StartsWith(nil)", printed);
        Assert.DoesNotContain("default(object)", printed);
        Assert.DoesNotContain("nil!!", printed);
    }

    /// <summary>
    /// C#'s suppression on a null literal must not manufacture a non-null G#
    /// value. Keeping <c>nil</c> lets the target type accept nullable sinks and
    /// reject genuinely non-null sinks.
    /// </summary>
    [Fact]
    public void SuppressNullableWarning_OnNullLiteral_PreservesTargetChecking()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("base(nil)", printed);
        Assert.DoesNotContain("default(Node)", printed);
        Assert.DoesNotContain("nil!!", printed);
    }

    /// <summary>
    /// An embedded post-increment used as an expression (<c>a[i++] = v</c>) is
    /// hoisted: the sub-expression reads the pre-increment value and the
    /// mutation is appended as a trailing <c>i++</c> statement (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void PostIncrement_AsExpression_HoistedToTrailingStatement()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static void Set(int[] a, int i)
        {
            a[i++] = 7;
        }
    }
}");

        Assert.Contains("a[i] = 7", printed);
        Assert.Contains("i++", printed);
    }

    /// <summary>
    /// <c>yield break</c> maps to G#'s native <c>yield break</c> statement
    /// (issue #3501 A1), which terminates the iterator from any depth.
    /// </summary>
    [Fact]
    public void YieldBreak_TranslatesNatively()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("yield break", printed);
        Assert.DoesNotContain("__iteratorExit", printed);
        Assert.DoesNotContain("goto", printed);
        Assert.DoesNotContain("unsupported", printed);
    }

    /// <summary>
    /// Issue #3394: iterator accessors and local functions use their own body
    /// as the synthesized <c>yield break</c> target.
    /// </summary>
    [Fact]
    public void YieldBreak_InGetterAndLocalFunction_UsesMatchingExitLabels()
    {
        string printed = TranslateUnit(@"
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
}");

        string[] exits = printed.Split('\n')
            .Where(line => line.Contains("__iteratorExit", StringComparison.Ordinal))
            .Select(line =>
            {
                int start = line.IndexOf("__iteratorExit", StringComparison.Ordinal);
                int end = start + "__iteratorExit".Length;
                while (end < line.Length && char.IsDigit(line[end]))
                {
                    end++;
                }

                return line.Substring(start, end - start);
            })
            .ToArray();

        // Issue #3501 A1: `yield break` translates to G#'s native
        // `yield break` — no synthesized exit labels remain.
        Assert.Empty(exits);
        Assert.Equal(2, printed.Split('\n').Count(line => line.TrimEnd().EndsWith("yield break", StringComparison.Ordinal)));
    }

    /// <summary>
    /// A field-like event maps to the canonical G# <c>event Name Type</c>
    /// (name-then-type, no accessor body, nullable annotation dropped).
    /// </summary>
    [Fact]
    public void EventField_MappedToEventDeclaration()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public event System.EventHandler<int>? Changed;
    }
}");

        Assert.Contains("event Changed EventHandler[int32]", printed);
    }

    /// <summary>
    /// A UTF-8 string literal <c>""…""u8</c> maps to a G# byte-slice literal
    /// <c>[]uint8{ … }</c> of the UTF-8 bytes (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void Utf8StringLiteral_MappedToByteSlice()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static System.ReadOnlySpan<byte> Tag() => ""AB""u8;
    }
}");

        Assert.Contains("[]uint8{", printed);
        Assert.Contains("0x41", printed);
        Assert.Contains("0x42", printed);
    }

    /// <summary>
    /// A <c>foreach</c> over a tuple deconstruction translates directly to G#'s
    /// first-class deconstructing for-in header (<c>for (a, b) in xs { … }</c>,
    /// issue #1922) instead of a hidden temp variable plus a separate
    /// <c>let (a, b) = tmp</c> statement. The G# two-name <c>for k, v in xs</c>
    /// form is index/element iteration, NOT tuple deconstruction (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void ForEachVariable_TupleDeconstruction_DeconstructsElementInBody()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("for (a, b) in xs {", printed);
        Assert.DoesNotContain("__decon", printed);
        Assert.DoesNotContain("for a, b in xs", printed);
    }

    /// <summary>
    /// A type reference that Roslyn parses as a constant pattern after a pattern
    /// combinator (<c>is Frame f and not EmptyFrame</c>) is a type test, not an
    /// equality <c>x != EmptyFrame</c> (which would treat the type name as a value
    /// → GS0125). ADR-0166 / issue #3409: the designation <c>f</c> qualifies as a
    /// native pattern variable, so the whole pattern — including the
    /// <c>and not EmptyFrame</c> type-pattern conjunct — is emitted verbatim.
    /// </summary>
    [Fact]
    public void IsPattern_TypeReferenceAfterCombinator_KeepsNativeTypePattern()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Frame { }
    public sealed class EmptyFrame : Frame { }
    public static class C
    {
        public static bool IsRealFrame(object o) => o is Frame f and not EmptyFrame;
    }
}");

        Assert.Contains("o is Frame f and not EmptyFrame", printed);
        Assert.DoesNotContain("!= EmptyFrame", printed);
        Assert.DoesNotContain("== EmptyFrame", printed);
        Assert.DoesNotContain("as Frame", printed);
        Assert.DoesNotContain("__spill", printed);
    }

    /// <summary>
    /// A C# <c>await foreach</c> over an <c>IAsyncEnumerable&lt;T&gt;</c> lowers to
    /// G#'s asynchronous-iteration form <c>await for x in seq</c> (spec
    /// AwaitForRangeStmt). A plain <c>for x in seq</c> over an async sequence is
    /// rejected by gsc (GS0116 "not indexable").
    /// </summary>
    [Fact]
    public void AwaitForeach_LowersToAwaitForLoop()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("await for x in src", printed);
        Assert.DoesNotMatch(@"(?<!await )for x in src", printed);
    }

    /// <summary>
    /// A non-async <c>foreach</c> still lowers to a plain <c>for x in seq</c>
    /// (no spurious <c>await</c>).
    /// </summary>
    [Fact]
    public void Foreach_NonAsync_LowersToPlainForLoop()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("for x in src", printed);
        Assert.DoesNotContain("await for", printed);
    }

    /// <summary>
    /// A control character inside a string literal (here NUL from C# <c>\0</c>)
    /// is re-escaped as a <c>\uXXXX</c> escape so the emitted G# string stays
    /// terminated and round-trips (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void StringLiteral_WithControlCharacter_EscapedAsUnicode()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static string Nulls() => ""\0\0\0"";
    }
}");

        Assert.Contains("\\u0000", printed);
    }

    /// <summary>
    /// A generic call chained after a null-conditional <c>?.</c>
    /// (<c>t.GetChild&lt;MdiaBox&gt;()?.GetChild&lt;HdlrBox&gt;()</c>) must keep
    /// its type arguments on every link of the chain, not just the first
    /// (ADR-0115 §B). The member-binding after <c>?.</c> carries a
    /// <c>GenericNameSyntax</c> whose type-argument list must be lifted onto the
    /// G# bracket form, otherwise the chained call loses <c>[T…]</c> and binds to
    /// the wrong (or no) overload.
    /// </summary>
    [Fact]
    public void NullConditionalChainedGenericCall_PreservesTypeArguments()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class HdlrBox { public string HandlerType => ""soun""; }
    public class MdiaBox { public T GetChild<T>() => default; }
    public class TrakBox { public T GetChild<T>() => default; }
    public static class C
    {
        public static string Handler(TrakBox t) =>
            t.GetChild<MdiaBox>()?.GetChild<HdlrBox>()?.HandlerType;
    }
}");

        Assert.Contains("t.GetChild[MdiaBox]()?.GetChild[HdlrBox]()?.HandlerType", printed);
        Assert.DoesNotContain("?.GetChild()", printed);
    }

    /// <summary>
    /// A reference to a nested BCL type
    /// (<c>ConfiguredTaskAwaitable.ConfiguredTaskAwaiter</c>) must be qualified
    /// with its containing type (ADR-0115 §B.12). Emitting the innermost name
    /// alone produces an unresolvable <c>ConfiguredTaskAwaiter</c> (GS0113).
    /// </summary>
    [Fact]
    public void NestedBclType_QualifiedWithContainingType()
    {
        string printed = TranslateUnit(@"
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
namespace Demo
{
    public class C
    {
        public ConfiguredTaskAwaitable.ConfiguredTaskAwaiter Awaiter(Task t) =>
            t.ConfigureAwait(false).GetAwaiter();
    }
}");

        Assert.Contains("ConfiguredTaskAwaitable.ConfiguredTaskAwaiter", printed);
    }

    /// <summary>
    /// Issue #3357: enum extensions use the explicit receiver-clause form and
    /// retain member-call syntax.
    /// </summary>
    [Fact]
    public void EnumExtensionMethod_UsesExplicitReceiverAndMemberCall()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("func extension (channels ChannelGroups) ChannelCount() int32", printed);
        Assert.Contains("g.ChannelCount()", printed);
        Assert.DoesNotContain("Ac4Extensions.ChannelCount(g)", printed);
    }

    /// <summary>
    /// Defect #914-1: a parameterless-constructor assignment whose right-hand side
    /// reads an instance member (here the abstract instance property
    /// <c>InputBufferSize</c>) must NOT be hoisted into a G# field initializer — a
    /// field initializer cannot reference instance state (GS0125). Issue #2746
    /// keeps the entire explicit class constructor, preserving both assignments'
    /// order and the fields' visibility.
    /// </summary>
    [Fact]
    public void CtorAssignment_ReferencingInstanceMember_StaysInInitBody()
    {
        string printed = TranslateUnit(@"
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
}");

        // The instance-member-dependent assignment is kept in an init() body.
        Assert.Contains("init()", printed);
        Assert.Contains("cache = [8]int32", printed);
        Assert.Contains("buffer = [InputBufferSize]TInput", printed);

        // The field itself carries no (invalid) initializer.
        Assert.Contains("var buffer []TInput", printed);
        Assert.DoesNotContain("var buffer []TInput = ", printed);

        // The static-RHS sibling remains in the same explicit constructor.
        Assert.Contains("let cache []int32", printed);
        Assert.DoesNotContain("let cache []int32 = ", printed);
    }

    /// <summary>
    /// Defect #914-2: a C# iterator method declared to return
    /// <c>IEnumerator&lt;T&gt;</c> maps to the G# return type
    /// <c>IEnumerator[T]</c> (NOT <c>sequence[T]</c>), so it satisfies
    /// <c>IEnumerable[T].GetEnumerator</c>. The explicit non-generic
    /// <c>IEnumerable.GetEnumerator</c> keeps its qualifier so imported metadata
    /// never contains a return-type-only public overload pair (issue #2822).
    /// A method returning <c>IEnumerable&lt;T&gt;</c> still maps to
    /// <c>sequence[T]</c>.
    /// </summary>
    [Fact]
    public void IteratorReturningIEnumeratorOfT_MapsToIEnumeratorOfT()
    {
        string printed = TranslateUnit(@"
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
}");

        // The IEnumerator<T> iterator keeps the IEnumerator[T] return type.
        Assert.Contains("func GetEnumerator() IEnumerator[T]", printed);
        Assert.DoesNotContain("func GetEnumerator() sequence[T]", printed);

        // The non-generic explicit implementation keeps its qualifier and
        // C#-faithful private visibility.
        Assert.Contains("private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()", printed);
        Assert.DoesNotContain($"{Environment.NewLine}    func GetEnumerator() IEnumerator ->", printed);

        // The IEnumerable<T> generator still lowers to sequence[T].
        Assert.Contains("func All() sequence[T]", printed);
        AssertGscCompiles(printed);
    }

    /// <summary>
    /// Issue #3814: an explicit implementation of an IMPORTED GENERIC
    /// interface's member keeps its ADR-0149 clause and its C#-faithful private
    /// visibility. This case used to fall back to the #1911 named/forced-public
    /// path because gsc erased the clause's type arguments while resolving the
    /// CLR slot (GS0494); it now resolves the slot through the interface's open
    /// definition with the symbolic arguments substituted, so the fallback — and
    /// the duplicate-overload collisions it caused for a type implementing TWO
    /// instantiations — is gone.
    /// </summary>
    [Fact]
    public void GenericImportedExplicitInterfaceQualifier_KeepsClauseAndCompiles()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;

    public class Value<T> : IEquatable<T>
    {
        bool IEquatable<T>.Equals(T other) => true;
    }
}");

        Assert.Contains("private func (IEquatable[T]) Equals(other T) bool -> true", printed);
        AssertGscCompiles(printed);
    }

    /// <summary>
    /// Issue #3814: the shape that walled <c>test/Core.Tests</c> — one member
    /// explicitly implemented on TWO instantiations of the same imported generic
    /// interface. Dropping the clause made the two methods differ only in return
    /// type, i.e. a duplicate overload (GS0264) plus an unimplemented interface
    /// (GS0187). Both clauses must now survive.
    /// </summary>
    [Fact]
    public void TwoInstantiationsOfOneImportedGenericInterface_KeepBothClauses()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("(IEnumerable[int32]) GetEnumerator() IEnumerator[int32]", printed);
        Assert.Contains("(IEnumerable[string]) GetEnumerator() IEnumerator[string]", printed);
        Assert.Contains("(IEnumerable) GetEnumerator() IEnumerator", printed);
        AssertGscCompiles(printed);
    }

    /// <summary>
    /// Defect #914-3: a C# binary expression that relied on implicit numeric
    /// promotion across differing operand types (here <c>ushort? == int</c>) must
    /// emit an explicit conversion so both operands share a G# type — G# has no
    /// implicit cross-type numeric promotion (GS0129). The constant literal is
    /// retyped to the other operand's G# type.
    /// </summary>
    [Fact]
    public void BinaryExpression_ImplicitNumericPromotion_MadeExplicit()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Entry { public ushort ChannelCount { get; set; } }

    public class C
    {
        public bool IsStereo(Entry? e) => e?.ChannelCount == 2;
    }
}");

        Assert.Contains("== (2 as uint16?)", printed);
    }

    /// <summary>
    /// Defect #914-3 guard: when the operands already share an underlying numeric
    /// type (only nullability differs, e.g. <c>int? == int</c>), no conversion is
    /// inserted — that form already compiles and must not be perturbed.
    /// </summary>
    [Fact]
    public void BinaryExpression_SameUnderlyingNumericType_NotPerturbed()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Entry { public int Count { get; set; } }

    public class C
    {
        public bool IsTwo(Entry? e) => e?.Count == 2;
    }
}");

        Assert.Contains("Count == 2", printed);
        Assert.DoesNotContain(" as int32", printed);
    }

    /// <summary>
    /// Oahu.Decrypt's <c>Artist?.Split(';')?[0]</c> uses a second safe index
    /// even though <c>String.Split</c> returns a non-null array. Keep null
    /// propagation from <c>Artist</c>, but render the dependent index as ordinary
    /// <c>[0]</c>; a genuinely nullable chain result must retain <c>?[0]</c>.
    /// </summary>
    [Fact]
    public void NullConditionalIndex_UsesImmediateChainResultNullability()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("Artist?.Split(';')[0]", printed);
        Assert.DoesNotContain("Artist?.Split(';')?[0]", printed);
        Assert.Contains("Provider?.MaybeItems()?[0]", printed);
        Assert.Contains("p?.Items?[0]", printed);
        Assert.Contains("p?[0]?[0]", printed);
        Assert.Contains("p?.MaybeValue?[5]", printed);
        Assert.Contains("p?.MaybeValueResult()?[6]", printed);
        Assert.Contains("return p?.Items?[0]", printed);
        AssertGscCompiles(printed, "GS0300");
    }

    [Fact]
    public void NullConditionalIndex_PreservesLiftedReceiverNullPropagation()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("p?[1]?[2]", printed);
        Assert.Contains("p?[3]?[4]", printed);
        Assert.DoesNotContain("!!", printed);
        AssertGscCompiles(printed, "GS0300");
    }

    [Fact]
    public void NullConditionalIndex_RetainsSafeIndexForPromotedMemberBindings()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("p?.FieldItems?[0]", printed);
        Assert.Contains("p?.PropertyItems?[0]", printed);
        AssertGscCompiles(printed, "GS0300");
    }

    /// <summary>
    /// A tuple literal element keeps the bare local when G#'s own flow analysis
    /// carries the preceding non-null guard into the tuple value.
    /// </summary>
    [Fact]
    public void TupleLiteralElement_GuardedNullable_UsesGSharpSmartCast()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("return (a,", printed);
        Assert.DoesNotContain("a!!", printed);
    }

    private static string TranslateUnit(string source, string roundTripOnlyReason = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static void AssertGscCompiles(string source, params string[] forbiddenDiagnostics)
    {
        string compiler =
            GscInvoker.Resolve(null, "Release", AppContext.BaseDirectory) ??
            GscInvoker.Resolve(null, "Debug", AppContext.BaseDirectory);
        Assert.NotNull(compiler);

        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "compile-tests",
            "issue2822",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            string sourcePath = Path.Combine(directory, "translated.gs");
            File.WriteAllText(sourcePath, source);
            GscResult result = new GscInvoker(compiler).Compile(
                new[] { sourcePath },
                Path.Combine(directory, "translated.dll"),
                TargetKind.Library,
                Array.Empty<string>());

            Assert.True(result.Succeeded, result.Output);
            foreach (string diagnostic in forbiddenDiagnostics)
            {
                Assert.DoesNotContain(diagnostic, result.Output);
            }
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
