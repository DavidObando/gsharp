// <copyright file="OahuDecryptTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
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
    /// A C# throw-expression on the right of <c>??</c> is lowered to the
    /// uniform value-position form <c>if true { throw … default(T) } else {
    /// default(T) }</c> (G# `throw` is statement-only; ADR-0115 §B).
    /// </summary>
    [Fact]
    public void ThrowExpression_InNullCoalescing_LoweredToIfExpression()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class C
    {
        public static string Get(string? s) => s ?? throw new System.ArgumentNullException(nameof(s));
    }
}");

        Assert.Contains("throw ", printed);
        Assert.Contains("if true {", printed);
    }

    /// <summary>
    /// A C# throw-expression in a ternary branch (<c>cond ? v : throw e</c>) is
    /// lowered through the same value-position throw form inside the G#
    /// if-expression branch.
    /// </summary>
    [Fact]
    public void ThrowExpression_InTernaryBranch_LoweredToIfExpression()
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
    /// A range index over a span (<c>s[a..b]</c>) lowers to a <c>.Slice(start,
    /// length)</c> call — G# has no range operator (gsc gap; ADR-0115 §G).
    /// </summary>
    [Fact]
    public void RangeExpression_OverSpan_LoweredToSlice()
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

        Assert.Contains("Slice(1, 3 - 1)", printed);
        Assert.Contains("Slice(2)", printed);
        Assert.Contains("Slice(0, 4)", printed);
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
    /// <c>yield break</c> maps to a plain G# <c>break</c> (settled fact: G# has
    /// no <c>yield break</c>; ADR-0115 §B).
    /// </summary>
    [Fact]
    public void YieldBreak_MappedToBreak()
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

        Assert.Contains("break", printed);
        Assert.DoesNotContain("yield break", printed);
        Assert.DoesNotContain("unsupported", printed);
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

        Assert.Contains("event Changed (object?, int32) -> void", printed);
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
    /// A <c>foreach</c> over a tuple deconstruction maps to the G# two-name
    /// iteration <c>for a, b in xs</c> (ADR-0115 §B).
    /// </summary>
    [Fact]
    public void ForEachVariable_TupleDeconstruction_MappedToTwoNameForIn()
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

        Assert.Contains("for a, b in xs", printed);
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
    /// A C# extension method whose <c>this</c> receiver is an enum cannot use the
    /// G# receiver-clause form (ADR-0079; gsc rejects it with GS0103 "receiver
    /// type must be a struct or class declared in the same package"). It must be
    /// emitted as a plain static helper and its call sites rewritten to the
    /// positional form <c>Owner.Method(receiver, …)</c>.
    /// </summary>
    [Fact]
    public void EnumExtensionMethod_EmittedAsPlainFunc_AndCallSiteRewritten()
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

        Assert.Contains("func ChannelCount(channels ChannelGroups) int32", printed);
        Assert.DoesNotContain("func (channels ChannelGroups) ChannelCount", printed);
        Assert.Contains("Ac4Extensions.ChannelCount(g)", printed);
    }

    private static string TranslateUnit(string source)
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
