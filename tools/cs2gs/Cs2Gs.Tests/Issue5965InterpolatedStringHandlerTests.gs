// <copyright file="Issue5965InterpolatedStringHandlerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #5965: lower interpolated-string-handler conversions uniformly across
/// both source and imported callees, and for both source-defined and imported
/// `[InterpolatedStringHandler]` `ref struct` types.
open class Issue5965InterpolatedStringHandlerTests {
    @Fact
    func ImportedAndSourceHandlers_SourceAndImportedCallees_RunLikeCSharp() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
using System.Runtime.CompilerServices;
using System.Text;
using HandlerLib;

[InterpolatedStringHandler]
public ref struct SourceHandler {
    private readonly StringBuilder sb;
    public SourceHandler(int literalLength, int formattedCount) {
        sb = new StringBuilder();
        sb.Append($"[{literalLength}/{formattedCount}]");
    }
    public void AppendLiteral(string text) { sb.Append(text); }
    public void AppendFormatted(int value) { sb.Append('#').Append(value); }
    public void AppendFormatted(string? value) { sb.Append('(').Append(value).Append(')'); }
    public override string ToString() => sb.ToString();
}

public static class Demo {
    private static string last = "";
    private static void AcceptImported(Handler handler) { last = "S-Imp"; }
    private static void AcceptSource(SourceHandler handler) { last = handler.ToString(); }
    private static string AcceptString(string text) => "str:" + text;

    public static string Run() {
        Library.Accept($"{1}");
        AcceptImported($"{2}");
        AcceptSource($"a={3},b={"hi"}");
        return last + "|" + AcceptString($"{4}");
    }
}
`, `
using System.Runtime.CompilerServices;
namespace HandlerLib;
[InterpolatedStringHandler]
public ref struct Handler {
    public Handler(int literalLength, int formattedCount) { }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}
public static class Library {
    public static void Accept(Handler handler) { }
}
        `, strictIl: true, expectedOutput: "[5/2]a=#3,b=(hi)|str:4")
        // Ordinary string interpolation remains native G# interpolation.
        Assert.Contains(`"${4}"`, printed, StringComparison.Ordinal)
        Assert.DoesNotContain("DefaultInterpolatedStringHandler", printed, StringComparison.Ordinal)
    }

    @Fact
    func InHandler_WidenedForwarded_AlignmentFormat_AndConditionalBranch_RunLikeCSharp() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
using System;
using System.Runtime.CompilerServices;
using System.Text;

[InterpolatedStringHandler]
public ref struct WideInHandler {
    private readonly StringBuilder sb;
    public WideInHandler(int literalLength, int formattedCount) {
        sb = new StringBuilder();
    }
    public WideInHandler(int literalLength, int formattedCount, long seed, out bool valid) {
        sb = new StringBuilder();
        sb.Append(seed).Append(':');
        valid = seed > 0;
    }
    public void AppendLiteral(string text) { sb.Append(text); }
    public void AppendFormatted(int value, int alignment = 0, string? format = null) {
        sb.Append(value.ToString(format)).Append('@').Append(alignment);
    }
    public void AppendFormatted<T>(T value) { sb.Append(value); }
    public override string ToString() => sb.ToString();
}

[InterpolatedStringHandler]
public ref struct InSeedHandler {
    private readonly StringBuilder sb;
    public InSeedHandler(int literalLength, int formattedCount, in int seed, out bool valid) {
        sb = new StringBuilder();
        sb.Append(seed).Append(':');
        valid = seed > 0;
    }
    public void AppendLiteral(string text) { sb.Append(text); }
    public void AppendFormatted(int value) { sb.Append(value); }
    public override string ToString() => sb.ToString();
}

public static class Demo {
    private static string AcceptIn(in WideInHandler handler) => handler.ToString();
    private static string WriteWide(int seed, [InterpolatedStringHandlerArgument("seed")] in WideInHandler handler) {
        return seed + ">" + handler.ToString();
    }
    private static string WriteInSeed(in int seed, [InterpolatedStringHandlerArgument("seed")] InSeedHandler handler) {
        return seed + ">" + handler.ToString();
    }

    public static string Run() {
        WideInHandler direct = $"a{1}";
        var inRes = AcceptIn($"b{255,4:X}");
        int s = 5;
        var wideRes = WriteWide(s, $"c{7}");
        var inSeed1 = WriteInSeed(in s, $"x{1}");
        int zero = 0;
        var inSeed2 = WriteInSeed(in zero, $"y{2}");
        return direct.ToString() + "|" + inRes + "|" + wideRes + "|" + inSeed1 + "|" + inSeed2;
    }
}
`, strictIl: true, expectedOutput: "a1|bFF@4|5>5:c7|5>5:x1|0>0:")
    }

    @Fact
    func GatedHandlers_AndEvaluationOrder_PreserveShortCircuitAndSingleEvaluation() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
using System.Runtime.CompilerServices;
using System.Text;

[InterpolatedStringHandler]
public ref struct SourceGatedHandler {
    private readonly StringBuilder? sb;
    private readonly bool keepAppending;
    public static int CtorCalls, LiteralCalls, FormattedCalls, Holes, Flags, Receivers, Afters;

    public SourceGatedHandler(int literalLength, int formattedCount, bool enabled, out bool shouldAppend)
        : this(literalLength, formattedCount, enabled, true, out shouldAppend) { }

    public SourceGatedHandler(int literalLength, int formattedCount, bool enabled, bool append, out bool shouldAppend) {
        CtorCalls++;
        keepAppending = append;
        shouldAppend = enabled;
        sb = enabled ? new StringBuilder() : null;
    }

    public bool AppendLiteral(string text) {
        LiteralCalls++;
        sb?.Append(text);
        return keepAppending;
    }

    public bool AppendFormatted(string? value) {
        FormattedCalls++;
        sb?.Append(value);
        return keepAppending;
    }

    public override string ToString() => sb?.ToString() ?? "disabled";
}

public sealed class SourceLogger {
    public string Prefix { get; }
    public SourceLogger(string prefix) { Prefix = prefix; }
    public string Log(bool enabled, bool append, [InterpolatedStringHandlerArgument("enabled", "append")] SourceGatedHandler handler) {
        return Prefix + ":" + handler.ToString();
    }
}

public static class SourceExt {
    public static string LogExt(this SourceLogger logger, bool enabled, [InterpolatedStringHandlerArgument("enabled")] SourceGatedHandler handler) {
        return logger.Prefix + ":" + handler.ToString();
    }
}

public static class Demo {
    private static bool Flag(bool value) { SourceGatedHandler.Flags++; return value; }
    private static string Hole(string text) { SourceGatedHandler.Holes++; return text; }
    private static SourceLogger NextLogger() { SourceGatedHandler.Receivers++; return new SourceLogger("L"); }
    private static int After() { SourceGatedHandler.Afters++; return 9; }

    private static string WriteOrdered(bool enabled, int tail, [InterpolatedStringHandlerArgument("enabled")] SourceGatedHandler handler) {
        return enabled + ":" + handler.ToString() + ":" + tail;
    }

    public static string Run() {
        var r1 = NextLogger().Log(Flag(false), Flag(true), $"p{Hole("a")}");
        var r2 = NextLogger().Log(Flag(true), Flag(false), $"p{Hole("b")}");
        var r3 = NextLogger().Log(Flag(true), Flag(true), $"p{Hole("c")}");
        var r4 = NextLogger().LogExt(Flag(true), $"x{Hole("d")}");
        var r5 = SourceExt.LogExt(NextLogger(), Flag(false), $"y{Hole("e")}");
        var r6 = WriteOrdered(enabled: Flag(true), handler: $"z{Hole("f")}", tail: After());
        return r1 + "|" + r2 + "|" + r3 + "|" + r4 + "|" + r5 + "|" + r6 + "|" +
            SourceGatedHandler.CtorCalls + ":" + SourceGatedHandler.LiteralCalls + ":" +
            SourceGatedHandler.FormattedCalls + ":" + SourceGatedHandler.Holes + ":" +
            SourceGatedHandler.Flags + ":" + SourceGatedHandler.Receivers + ":" + SourceGatedHandler.Afters;
    }
}
        `, strictIl: true, expectedOutput: "L:disabled|L:p|L:pc|L:xd|L:disabled|True:zf:9|6:4:3:3:9:5:1")
    }

    @Fact
    func ReceiverAndRefForwardedHandlers_AndBclStringBuilder_RunLikeCSharp() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
using System;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;

[InterpolatedStringHandler]
public ref struct ReceiverRefHandler {
    private readonly StringBuilder buf;
    public ReceiverRefHandler(int literalLength, int formattedCount, LogBuffer receiver, ref int counter, out bool valid) {
        counter++;
        buf = receiver.Buffer;
        valid = counter <= 3;
    }
    public void AppendLiteral(string text) { buf.Append(text); }
    public void AppendFormatted(int value) { buf.Append(value); }
}

public sealed class LogBuffer {
    public readonly StringBuilder Buffer = new StringBuilder();
    public void Append(ref int counter, [InterpolatedStringHandlerArgument("", "counter")] ref ReceiverRefHandler handler) {
        Buffer.Append('|').Append(counter);
    }
}

public static class Demo {
    private static int indexCalls;
    private static int[] counters = new[] { 1, 10 };
    private static int NextIndex() { indexCalls++; return 0; }
    private static LogBuffer? MaybeLogger(bool present) => present ? new LogBuffer() : null;

    public static string Run() {
        var log = new LogBuffer();
        log.Append(ref counters[NextIndex()], $"a{10}");
        log.Append(ref counters[1], $"b{20}");
        var maybe = MaybeLogger(false);
        maybe?.Append(ref counters[0], $"c{30}");
        var sb = new StringBuilder();
        sb.Append($"s={1 + 2}");
        sb.Append(CultureInfo.InvariantCulture, $",f={3.5:0.0}");
        var direct = $"d={42}";
        var span = new char[16];
        var ok = MemoryExtensions.TryWrite(span, $"t={7}", out var charsWritten);
        return log.Buffer.ToString() + "|" + counters[0] + ":" + counters[1] + ":" + indexCalls +
            "|" + sb.ToString() + "|" + direct + "|" + ok + ":" + new string(span, 0, charsWritten);
    }
}
`, strictIl: true, expectedOutput: "a10|2|11|2:11:1|s=3,f=3.5|d=42|True:t=7")
    }

    @Fact
    func SourceHandlers_CallEffectsAndNarrowing_PreserveAndInvalidateCorrectly() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Runtime.CompilerServices;

[InterpolatedStringHandler]
public ref struct MutatingSourceHandler {
    public MutatingSourceHandler(int literalLength, int formattedCount) { Demo.Global = null; }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public readonly ref struct ReadonlySourceHandler {
    public ReadonlySourceHandler(int literalLength, int formattedCount) { }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public ref struct GatedNarrowHandler {
    public GatedNarrowHandler(int literalLength, int formattedCount, bool enabled, out bool valid) {
        valid = enabled;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(string value) { }
}

[InterpolatedStringHandler]
public ref struct UnconditionalNarrowHandler {
    public UnconditionalNarrowHandler(int literalLength, int formattedCount) { }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(string value) { }
}

public static class Demo {
    public static string? Global;
    private static void AcceptMutating(MutatingSourceHandler h) { }
    private static void AcceptReadonly(ReadonlySourceHandler h) { }
    private static void AcceptGated(bool enabled, [InterpolatedStringHandlerArgument("enabled")] GatedNarrowHandler h) { }
    private static void AcceptUnconditional(UnconditionalNarrowHandler h) { }

    private static void PureNoOp() { }

    private static int GuardMutating(ref string? s) {
        if (s == null) return 0;
        AcceptMutating($"{1}");
        return s.Length + 10;
    }

    private static int GuardReadonly(ref string? s) {
        if (s == null) return 0;
        AcceptReadonly($"{1}");
        return s.Length + 20;
    }

    private static int GuardPureControl(ref string? s) {
        if (s == null) return 0;
        PureNoOp();
        return s.Length + 30;
    }

    private static char? GatedHole(bool enabled) {
        string? s = null;
        AcceptGated(enabled, $"{s ??= "g"}");
        return s?[0];
    }

    private static char UnconditionalHole() {
        string? s = null;
        AcceptUnconditional($"{s ??= "u"}");
        return s[0];
    }

    public static string Run() {
        Global = "safe";
        string mutResult;
        try { mutResult = GuardMutating(ref Global).ToString(); }
        catch (NullReferenceException) { mutResult = "cleared"; }
        Global = "safe";
        var roResult = GuardReadonly(ref Global);
        var pureResult = GuardPureControl(ref Global);
        return mutResult + "|" + roResult + "|" + pureResult + "|" + GatedHole(false) + "|" + GatedHole(true) + "|" + UnconditionalHole();
    }
}
`, rejectConditionalIndexWarnings: true, strictIl: true, rejectedWarning: "GS0536", expectedOutput: "cleared|24|34||g|u")
        Assert.Contains("return s!!.Length + 10", printed, StringComparison.Ordinal)
        Assert.Contains("return s!!.Length + 20", printed, StringComparison.Ordinal)
        Assert.Contains("return s.Length + 30", printed, StringComparison.Ordinal)
        Assert.Contains("return s?[0]", printed, StringComparison.Ordinal)
        Assert.Contains("return s[0]", printed, StringComparison.Ordinal)
    }

    @Fact
    func StandaloneAdditionCastConstructorAndIndexerHandlers_RunLikeCSharp() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
using System.Runtime.CompilerServices;
using System.Text;

[InterpolatedStringHandler]
public ref struct TextHandler {
    private readonly StringBuilder sb;
    public TextHandler(int literalLength, int formattedCount) {
        sb = new StringBuilder();
    }
    public TextHandler(int literalLength, int formattedCount, bool upper, out bool valid) {
        sb = new StringBuilder();
        if (upper) sb.Append("U:");
        valid = true;
    }
    public void AppendLiteral(string text) { sb.Append(text); }
    public void AppendFormatted(int value) { sb.Append(value); }
    public override string ToString() => sb.ToString();
}

public sealed class Holder {
    public string Captured { get; }
    public string LastIndexed = "";
    public Holder(bool upper, [InterpolatedStringHandlerArgument("upper")] TextHandler handler) {
        Captured = handler.ToString();
    }
    public string this[bool upper, [InterpolatedStringHandlerArgument("upper")] TextHandler handler] {
        get => handler.ToString();
        set => LastIndexed = handler.ToString() + "=" + value;
    }
}

public static class Demo {
    private static string AcceptAddition(TextHandler handler) => handler.ToString();

    public static string Run() {
        TextHandler local = $"a={1}";
        var casted = ((TextHandler)$"b={2}").ToString();
        var added = AcceptAddition($"c={3}" + $"d={4}");
        var holder = new Holder(true, $"e={5}");
        var got = holder[false, $"f={6}"];
        holder[true, $"g={7}"] = "ok";
        return local.ToString() + "|" + casted + "|" + added + "|" + holder.Captured + "|" + got + "|" + holder.LastIndexed;
    }
}
`, strictIl: true, expectedOutput: "a=1|b=2|c=3d=4|U:e=5|f=6|U:g=7=ok")
    }

    @Fact
    func ReviewEdgeCases_DelegatesArrayReceiversDeferredNullAllowNullTwoHandlersNestedAndParens_RunLikeCSharp() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Text;
using ImportedAllowNullLib;

[InterpolatedStringHandler]
public ref struct NestedHoleHandler {
    public readonly string Text;
    public NestedHoleHandler(int literalLength, int formattedCount, NestedOuterHandler outer) {
        Text = outer.Tag + ":";
    }
    public NestedHoleHandler(int literalLength, int formattedCount) { Text = ""; }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public ref struct NestedOuterHandler {
    public readonly string Tag;
    private readonly StringBuilder sb;
    public NestedOuterHandler(int literalLength, int formattedCount) {
        Tag = "OUTER";
        sb = new StringBuilder();
    }
    public void AppendLiteral(string text) { sb.Append(text); }
    public void AppendFormatted([InterpolatedStringHandlerArgument("")] NestedHoleHandler nested) {
        sb.Append(nested.Text).Append('N');
    }
    public override string ToString() => sb.ToString();
}

[InterpolatedStringHandler]
public ref struct TwoStepHandler {
    public readonly string Value;
    public TwoStepHandler(int literalLength, int formattedCount) { Value = "H1"; }
    public TwoStepHandler(int literalLength, int formattedCount, TwoStepHandler first) {
        Value = first.Value + "+H2";
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public ref struct AllowNullForwardedHandler {
    public readonly string Value;
    public AllowNullForwardedHandler(int literalLength, int formattedCount, [AllowNull] string prefix, out bool valid) {
        Value = prefix ?? "<nil>";
        valid = true;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public ref struct StructRecvHandler {
    public readonly string LogText;
    public StructRecvHandler(int literalLength, int formattedCount, in StructCell cell) {
        LogText = "C" + cell.Count;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

public struct StructCell {
    public int Count;
    public void Mutate([InterpolatedStringHandlerArgument("")] StructRecvHandler handler) {
        Count += handler.LogText.Length;
    }
}

public static class StructExt {
    public static int ReadIn(this in StructCell cell, [InterpolatedStringHandlerArgument("cell")] StructRecvHandler handler) {
        return cell.Count;
    }
}

public sealed class ParenHolder {
    public string Last = "";
    public string this[bool upper, [InterpolatedStringHandlerArgument("upper")] ParenTextHandler handler] {
        get => handler.Text;
        set => Last = handler.Text + "=" + value;
    }
}

[InterpolatedStringHandler]
public ref struct ParenTextHandler {
    public readonly string Text;
    public ParenTextHandler(int literalLength, int formattedCount, bool upper) {
        Text = upper ? "U" : "L";
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

public static class Demo {
    private delegate string SinkDelegate(ref TwoStepHandler handler);
    private static SinkDelegate? sink;
    private static int nullSteps, parenHoles;
    private static StructCell[] cells = new StructCell[1];
    private static StructCell singleCell;
    private static ParenHolder? nullTarget;

    private static int ChangeSink() {
        sink = (ref TwoStepHandler h) => "NEW";
        return 1;
    }

    private static string AcceptTwo(TwoStepHandler first, [InterpolatedStringHandlerArgument("first")] TwoStepHandler second) {
        return second.Value;
    }

    private static string AcceptAllowNull([AllowNull] string prefix, [InterpolatedStringHandlerArgument("prefix")] AllowNullForwardedHandler handler) {
        return handler.Value;
    }

    private static string AcceptNested(NestedOuterHandler outer) => outer.ToString();

    private static int TouchSingleCell() {
        singleCell.Count = 77;
        return 1;
    }

    private static int StepNull() {
        nullSteps++;
        return 5;
    }

    private static int ParenHole() {
        parenHoles++;
        return 9;
    }

    public static string Run() {
        sink = (ref TwoStepHandler h) => "ORIG";
        var d1 = sink($"{ChangeSink()}");
        sink = (ref TwoStepHandler h) => "ORIG2";
        var d2 = sink.Invoke($"{ChangeSink()}");

        cells[0].Count = 3;
        cells[0].Mutate($"{1}");

        singleCell.Count = 10;
        var inExt = singleCell.ReadIn($"{TouchSingleCell()}");

        var two = AcceptTwo($"{1}", $"{2}");
        string? nullableStr = null;
        var allowNull = AcceptAllowNull(nullableStr, $"{1}");
        var impAllowNull = ImportedApi.CheckOblivious(nullableStr, $"{1}");
        var nested = AcceptNested($"a={$"b={1}"}");

        var ph = new ParenHolder();
        (ph[true, $"{ParenHole()}"]) = "ok";

        string nullResult;
        try {
            nullTarget = null;
            _ = nullTarget![ParenHole() > 0, $"{StepNull()}"];
            nullResult = "no-throw";
        } catch (NullReferenceException) {
            nullResult = "threw:" + nullSteps + ":" + parenHoles;
        }

        return d1 + "|" + d2 + "|" + cells[0].Count + "|" + inExt + "|" + two + "|" +
            allowNull + "|" + impAllowNull + "|" + nested + "|" + ph.Last + "|" + nullResult;
    }
}
`, `
#nullable disable
using System.Runtime.CompilerServices;
namespace ImportedAllowNullLib;
[InterpolatedStringHandler]
public ref struct ObliviousHandler {
    public readonly string Value;
    public ObliviousHandler(int literalLength, int formattedCount, string prefix, out bool valid) {
        Value = prefix ?? "<obliv>";
        valid = true;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}
public static class ImportedApi {
    public static string CheckOblivious(string prefix, [InterpolatedStringHandlerArgument("prefix")] ObliviousHandler handler) => handler.Value;
}
`, strictIl: true, expectedOutput: "ORIG|ORIG2|5|77|H1+H2|<nil>|<obliv>|a=OUTER:N|U=ok|threw:1:2")
    }

    @Fact
    func ReadonlyAncestorBoxedOutVarSpanLiteralConditionalExtAndDeferredNullRhs_RunLikeCSharp() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Runtime.CompilerServices;
using System.Text;
using RefIdxLib;

[InterpolatedStringHandler]
public struct BoxableFirstHandler {
    public string Value;
    public BoxableFirstHandler(int literalLength, int formattedCount) { Value = "B1"; }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public ref struct BoxedForwardHandler {
    public readonly object Captured;
    public BoxedForwardHandler(int literalLength, int formattedCount, object first) {
        Captured = first;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public ref struct OutForwardedHandler {
    public readonly int Seen;
    public OutForwardedHandler(int literalLength, int formattedCount, out int token, out bool valid) {
        token = 42;
        Seen = token;
        valid = true;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

[InterpolatedStringHandler]
public ref struct SpanLiteralHandler {
    private readonly StringBuilder sb;
    public SpanLiteralHandler(int literalLength, int formattedCount) {
        sb = new StringBuilder();
    }
    public SpanLiteralHandler(int literalLength, int formattedCount, int seed) {
        sb = new StringBuilder();
    }
    public SpanLiteralHandler(int literalLength, int formattedCount, bool upper) {
        sb = new StringBuilder();
    }
    public SpanLiteralHandler(int literalLength, int formattedCount, string? tag) {
        sb = new StringBuilder();
        sb.Append(tag ?? "nil").Append(':');
    }
    public void AppendLiteral(ReadOnlySpan<char> text) {
        sb.Append(text);
    }
    public void AppendFormatted(int value) {
        sb.Append(value);
    }
    public override string ToString() => sb.ToString();
}

[InterpolatedStringHandler]
public struct InnerCell {
    public int Count;
    public void Mutate([InterpolatedStringHandlerArgument("")] StructCellHandler handler) {
        Count += handler.Delta;
    }
}

[InterpolatedStringHandler]
public ref struct StructCellHandler {
    public readonly int Delta;
    public StructCellHandler(int literalLength, int formattedCount, in InnerCell cell) {
        Delta = cell.Count + 1;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

public struct OuterContainer {
    public InnerCell Cell;
}

public static class RefExtHelpers {
    public static int TouchExt(this Demo.PrivateTarget target, out int tag, [InterpolatedStringHandlerArgument("tag")] ref OutForwardedHandler handler) {
        tag = handler.Seen + 1;
        return target.BaseValue + tag;
    }
}

public sealed class ConvertibleInt {
    public static int Conversions;
    private readonly int value;
    public ConvertibleInt(int value) { this.value = value; }
    public static implicit operator int(ConvertibleInt c) {
        Conversions++;
        return c.value;
    }
}

public class PlainBaseCtor {
    public readonly string BaseSeen;
    public PlainBaseCtor(SpanLiteralHandler h) { BaseSeen = h.ToString(); }
}

public sealed class PlainDerivedCtor : PlainBaseCtor {
    public PlainDerivedCtor(int v) : base($"{v}") { }
}

public struct DefCopyCell {
    public int Value;
    public int Log(int seed, [InterpolatedStringHandlerArgument("seed")] SpanLiteralHandler h) => Value + h.ToString().Length;
}

public sealed class NullFlowTarget {
    public static int AfterCalls, RhsCalls, ParamsAfterCalls, PlainHoleCalls;
    public void Log(int seed, [InterpolatedStringHandlerArgument("seed")] SpanLiteralHandler handler, int after) { }
    public void PlainLog(SpanLiteralHandler handler) { }
    public void LogParams(int seed, [InterpolatedStringHandlerArgument("seed")] SpanLiteralHandler handler, params int[] rest) { }
    public string this[bool upper, [InterpolatedStringHandlerArgument("upper")] SpanLiteralHandler handler] {
        get => "";
        set { }
    }
    public int this[int tag, [InterpolatedStringHandlerArgument("tag")] SpanLiteralHandler handler] {
        get => 0;
        set { }
    }
}

public sealed class IncDecIndexerHolder {
    public int NextCalls;
    private int stored = 10;
    public int Next() { NextCalls++; return 1; }
    public int this[bool enabled, [InterpolatedStringHandlerArgument("enabled")] SpanLiteralHandler handler] {
        get => stored + handler.ToString().Length;
        set => stored = value - handler.ToString().Length;
    }
}

[InterpolatedStringHandler]
public struct ValueHandlerForDelegate {
    public string Text;
    public ValueHandlerForDelegate(int literalLength, int formattedCount) { Text = ""; }
    public void AppendLiteral(string text) { Text += text; }
    public void AppendFormatted(int value) { Text += value.ToString(); }
}

[InterpolatedStringHandler]
public ref struct GatedIncHandler {
    public bool Active;
    public GatedIncHandler(int literalLength, int formattedCount, bool enabled, out bool valid) {
        Active = enabled;
        valid = enabled;
    }
    public bool AppendLiteral(string text) => Active;
    public bool AppendFormatted(int value) {
        Active = value > 0;
        return Active;
    }
    public bool AppendFormatted((int A, int B) pair) {
        Active = pair.A > 0;
        return Active;
    }
}

#nullable disable
[InterpolatedStringHandler]
public ref struct PromotedRefArgHandler {
    private readonly StringBuilder sb;
    public PromotedRefArgHandler(int literalLength, int formattedCount, ref string tag) {
        if (tag == null) tag = null;
        sb = new StringBuilder();
        sb.Append(tag ?? "nil").Append(':');
    }
    public void AppendFormatted(int value) { sb.Append(value); }
    public override string ToString() => sb.ToString();
}

public interface ILogMutator {
    void Log(SpanLiteralHandler h);
}

public struct GenericMutatorCell : ILogMutator {
    public int Total;
    public void Log(SpanLiteralHandler h) { Total += h.ToString().Length; }
}

public sealed class ClassMutator : ILogMutator {
    public string Tag;
    public ClassMutator(string tag) { Tag = tag; }
    public void Log(SpanLiteralHandler h) { Tag += ":" + h.ToString(); }
}

public struct ByValExtStruct {
    public int X;
    public int Probe() => this.ReadWithHole($"{Bump()}");
    private int Bump() { X += 50; return 7; }
}

public static class ByValExtHelpers {
    public static int ReadWithHole(this ByValExtStruct s, SpanLiteralHandler h) => s.X + h.ToString().Length;
}

[InterpolatedStringHandler]
public ref struct InLongHandler {
    public readonly long Seen;
    public InLongHandler(int literalLength, int formattedCount, in long seed) { Seen = seed; }
    public void AppendFormatted(int v) { }
}

[InterpolatedStringHandler]
public ref struct ParamsAppendHandler {
    private readonly StringBuilder sb;
    public ParamsAppendHandler(int literalLength, int formattedCount) { sb = new StringBuilder(); }
    public void AppendLiteral(params string[] pieces) { foreach (var p in pieces) sb.Append(p); }
    public void AppendFormatted(params int[] values) { foreach (var v in values) sb.Append('#').Append(v); }
    public override string ToString() => sb.ToString();
}

[InterpolatedStringHandler]
public ref struct CallerInfoHandler {
    private readonly StringBuilder sb;
    public CallerInfoHandler(int literalLength, int formattedCount) { sb = new StringBuilder(); }
    public void AppendFormatted(int value, [CallerArgumentExpression("value")] string expr = "", [CallerLineNumber] int line = 0) {
        sb.Append(expr).Append('=').Append(value).Append('@').Append(line > 0);
    }
    public override string ToString() => sb.ToString();
}

[InterpolatedStringHandler]
public struct OrdinaryStructHandler {
    public readonly int Val;
    public OrdinaryStructHandler(int literalLength, int formattedCount) { Val = literalLength + formattedCount; }
    public void AppendFormatted(int v) { }
}

public sealed class OrdinaryHandlerHolder {
    public string Log = "";
    public int LastVal;
    public int this[OrdinaryStructHandler h] {
        get => LastVal + h.Val;
        set { Log += "S:" + value; LastVal = value + h.Val; }
    }
}

public sealed class UnqualifiedOutPropBox {
    private int[] slots = new int[2];
    private int idx;
    private ref int Slot => ref slots[idx];
    private int BumpIdx() { idx = 1; return 5; }
    private static void WriteSlot(out int target, [InterpolatedStringHandlerArgument("target")] OutForwardedHandler h) {
        target = 99 + h.Seen;
    }
    public string Run() {
        WriteSlot(out Slot, $"{BumpIdx()}");
        return slots[0] + ":" + slots[1];
    }
}

public struct RefReadOnlyParamStruct {
    public int Seed;
    public long Run(ref int other) => Write(ref other, $"{1}") + WriteThis(ref this, $"{2}");
    private static long Write(ref readonly int seed, [InterpolatedStringHandlerArgument("seed")] InIntHandler h) => seed + h.Seen;
    private static int WriteThis(ref readonly RefReadOnlyParamStruct self, [InterpolatedStringHandlerArgument("self")] StructCellHandlerForRo h) => self.Seed + h.Delta;
}

[InterpolatedStringHandler]
public ref struct InIntHandler {
    public readonly int Seen;
    public InIntHandler(int literalLength, int formattedCount, in int seed) { Seen = seed; }
    public void AppendFormatted(int v) { }
}

[InterpolatedStringHandler]
public ref struct StructCellHandlerForRo {
    public readonly int Delta;
    public StructCellHandlerForRo(int literalLength, int formattedCount, in RefReadOnlyParamStruct s) { Delta = s.Seed + 1; }
    public void AppendFormatted(int v) { }
}

[InterpolatedStringHandler]
public ref struct CondBaseReceiverHandler {
    public readonly string Text;
    public CondBaseReceiverHandler(int literalLength, int formattedCount, CondBaseHost host) {
        Text = host.Tag + ":";
    }
    public void AppendFormatted(int v) { }
}

public class CondBaseHost {
    public readonly string Tag;
    public CondBaseHost(string tag) { Tag = tag; }
    public string Log([InterpolatedStringHandlerArgument("")] CondBaseReceiverHandler h) => "D:" + h.Text + Tag;
    public string BaseLog([InterpolatedStringHandlerArgument("")] CondBaseReceiverHandler h) => "B:" + h.Text + Tag;
    public string Consume(string s) => Tag + "<-" + s;
}

public sealed class CondDerivedHost : CondBaseHost {
    public CondDerivedHost() : base("self") { }
    public new string BaseLog([InterpolatedStringHandlerArgument("")] CondBaseReceiverHandler h) => "NEW:" + h.Text + Tag;
    public string Probe(CondBaseHost? other) {
        var unqual = other?.Consume(Log($"{1}"));
        var baseCall = base.BaseLog($"{2}");
        return unqual + ";" + baseCall;
    }
}

public static class ObliviousPromotedRefHelper {
    public static string Touch(ref string target, [InterpolatedStringHandlerArgument("target")] PromotedRefArgHandler h) {
        string prev = target;
        target = "after:" + h.ToString();
        return (prev ?? "nil") + "->" + target;
    }
    public static string ProbePromoted() {
        string s = null;
        if (s != null) return "unreachable";
        s = "init";
        var res = Touch(ref s, $"{1}");
        return res;
    }
}
#nullable enable

public static class Demo {
    public sealed class PrivateTarget { public int BaseValue = 10; }
    private delegate string RefHandlerSink(int n, ref ValueHandlerForDelegate handler);
    private static int ungatedCounter;
    private static int nextPairCalls;
    private static DefCopyCell globalDefCell;
    private static RefIndexerCell globalRefIdxCell;
    private static int postIncSeedCounter;
    private static string postIncObserved = "";
    private static string? nullableField = "nf";
    private static int deconstructHoleCalls;
    private static int holeSawNextPair;
    private static string ordSeq = "";

    private static int TouchOrdHole() { ordSeq += "H"; return 1; }
    private static int TouchOrdRhs() { ordSeq += "R"; return 10; }

    private static int ChangeGlobalCell() { globalDefCell.Value = 999; return 42; }
    private static int ChangeRefIdxSlot() { globalRefIdxCell.Index = 1; return 9; }
    private static int ChangeRefIdxSlotAndValue() { globalRefIdxCell.Index = 1; return 88; }
    private static void WriteRefIndexer(in RefIndexerCell c) { c[$"{ChangeRefIdxSlot()}"] = 77; }
    private static int WriteRefIndexerRhsOrder(in RefIndexerCell c) {
        c[$"{1}"] = ChangeRefIdxSlotAndValue();
        globalRefIdxCell.Index = 0;
        var res = c[$"{1}"] = ChangeRefIdxSlotAndValue();
        return res;
    }
    private static void ProbeGenericMutating<T>(ref T receiver) where T : ILogMutator { receiver.Log($"{123}"); }
    private static int ReplaceClassReceiver<T>(ref T receiver, T replacement) { receiver = replacement; return 123; }
    private static void ProbeGenericClassReplace<T>(ref T receiver, T replacement) where T : ILogMutator {
        receiver.Log($"{ReplaceClassReceiver(ref receiver, replacement)}");
    }
    private static long AcceptInLong(int seed, [InterpolatedStringHandlerArgument("seed")] InLongHandler h) => h.Seen;
    private static string AcceptParamsAppend(ParamsAppendHandler h) => h.ToString();
    private static string AcceptRefNonNull(ref string s, SpanLiteralHandler h) { s = s + ":" + h.ToString(); return s; }
    private static string AcceptCallerInfo(CallerInfoHandler h) => h.ToString();
    private static int IncHoleBeforeDeconstruct() { deconstructHoleCalls++; holeSawNextPair = nextPairCalls; return 5; }
    private static string AcceptWithDeconstruct(SpanLiteralHandler h, (int A, int B) pair) => h.ToString() + ":" + pair.A + ":" + pair.B;
    private static string ReadPostIncSeed(int seed) { postIncObserved = seed + ":" + postIncSeedCounter; return postIncObserved; }
    private static void StmtPostIncSeed(int seed, [InterpolatedStringHandlerArgument("seed")] SpanLiteralHandler h) {
        postIncObserved = seed + ":" + postIncSeedCounter + ":" + h.ToString();
    }
    private static int ProbeDefensiveCopy(in DefCopyCell c) => c.Log(1, $"{ChangeGlobalCell()}");
    private static int PlainHole() { NullFlowTarget.PlainHoleCalls++; return 5; }

    private static int ReadInContainer(in OuterContainer container) {
        container.Cell.Mutate($"{1}");
        return container.Cell.Count;
    }

    private static string ReadRefReadOnlyLocal() {
        var cells = new InnerCell[1];
        cells[0].Count = 8;
        ref readonly InnerCell roCell = ref cells[0];
        roCell.Mutate($"{1}");
        return roCell.Count.ToString();
    }

    private static bool CheckBoxedSame(object first, [InterpolatedStringHandlerArgument("first")] BoxedForwardHandler second) {
        return ReferenceEquals(first, second.Captured);
    }

    private static string AcceptOut(out int x, [InterpolatedStringHandlerArgument("x")] OutForwardedHandler handler) {
        x = 99;
        return x + ":" + handler.Seen;
    }

    private static string AcceptSpanLiteral(SpanLiteralHandler handler) => handler.ToString();
    private static string AcceptUngatedCounter(SpanLiteralHandler handler) => handler.ToString() + ":" + ungatedCounter;
    private static void AcceptGated(bool enabled, [InterpolatedStringHandlerArgument("enabled")] GatedIncHandler handler) { }
    private static (int, int) NextPair() { nextPairCalls++; return (nextPairCalls * 10, nextPairCalls * 10 + 1); }

    private static int After() { NullFlowTarget.AfterCalls++; return 7; }
    private static int ParamsAfter() { NullFlowTarget.ParamsAfterCalls++; return 11; }
    private static string TouchRhs() { NullFlowTarget.RhsCalls++; return "ok"; }
    private static ConvertibleInt MakeConvertible() => new ConvertibleInt(42);

    public static string Run() {
        var container = new OuterContainer();
        container.Cell.Count = 5;
        var roCount = ReadInContainer(in container);
        var roLocalCount = ReadRefReadOnlyLocal();
        var promotedRefRes = ObliviousPromotedRefHelper.ProbePromoted();

        var sameBox = CheckBoxedSame((BoxableFirstHandler)$"{1}", $"{2}");

        var outVarRes = AcceptOut(out var outCreated, $"{1}");
        int existingOut = 0;
        var outExistingRes = AcceptOut(out existingOut, $"{1}");

        var spanLit = AcceptSpanLiteral($"lit-{9}");
        var baseCtorSeen = new PlainDerivedCtor(55).BaseSeen;
        ungatedCounter = 4;
        var ungatedRes = AcceptUngatedCounter($"{ungatedCounter++}");

        globalDefCell.Value = 100;
        var defCopyRes = ProbeDefensiveCopy(in globalDefCell);

        postIncSeedCounter = 7;
        StmtPostIncSeed(postIncSeedCounter++, $"{postIncSeedCounter}");
        var postIncArgRes = postIncObserved;

        PrivateTarget? maybeBoxed = new PrivateTarget();
        var condExtRes = maybeBoxed?.TouchExt(out var condOut, $"{1}");

        RefHandlerSink sink = (int n, ref ValueHandlerForDelegate h) => n + ":" + h.Text;
        var namedDelegateRes = sink(handler: $"{7}", n: 3);

        int gatedIdx = 10;
        AcceptGated(false, $"{gatedIdx++}");
        int afterFalseGated = gatedIdx;
        AcceptGated(true, $"{gatedIdx++}{gatedIdx++}");
        int afterTrueGated = gatedIdx;

        int pa = 0, pb = 0;
        AcceptGated(false, $"{((pa, pb) = NextPair())}");
        int pairAfterFalse = nextPairCalls + pa + pb;
        AcceptGated(true, $"{((pa, pb) = NextPair())}{((pa, pb) = NextPair())}");
        AcceptGated(true, $"{0}{((pa, pb) = NextPair())}");
        string pairAfterTrue = nextPairCalls + ":" + pa + ":" + pb;

        var deconstructOrderRes = AcceptWithDeconstruct($"{IncHoleBeforeDeconstruct()}", ((pa, pb) = NextPair())) +
            ":" + deconstructHoleCalls + ":" + holeSawNextPair;

        var ordHolder = new OrdinaryHandlerHolder();
        ordHolder[$"{TouchOrdHole()}"] = TouchOrdRhs();
        int ca = 0, cb = 0;
        ordHolder[$"{1}"] += ((ca, cb) = (2, 3)).Item1;
        var ordExpr = ordHolder[$"{1}"] += ((ca, cb) = (4, 5)).Item2;
        var ordCompoundRes = ordSeq + ":" + ordHolder.LastVal + ":" + ordExpr + ":" + ca + ":" + cb;

        var unqualOutRes = new UnqualifiedOutPropBox().Run();
        int roOther = 10;
        var roStruct = new RefReadOnlyParamStruct { Seed = 20 };
        var roRefArgRes = roStruct.Run(ref roOther);
        var condBaseRes = new CondDerivedHost().Probe(new CondBaseHost("other"));

        var refNonNullRes = AcceptRefNonNull(ref nullableField!, $"{8}");

        globalRefIdxCell = new RefIndexerCell { Index = 0, Slots = new int[2] };
        WriteRefIndexer(in globalRefIdxCell);
        var refIdxRes = globalRefIdxCell.Slots[0] + ":" + globalRefIdxCell.Slots[1];

        globalRefIdxCell = new RefIndexerCell { Index = 0, Slots = new int[2] };
        var refOrderExpr = WriteRefIndexerRhsOrder(in globalRefIdxCell);
        var refIdxRhsOrderRes = globalRefIdxCell.Slots[0] + ":" + globalRefIdxCell.Slots[1] + ":" + refOrderExpr;

        var condLeft = new InnerCell { Count = 10 };
        var condRight = new InnerCell { Count = 20 };
        bool chooseLeft = true;
        (chooseLeft ? ref condLeft : ref condRight).Mutate($"{1}");
        chooseLeft = false;
        (chooseLeft ? ref condLeft : ref condRight).Mutate($"{1}");
        var refCondRes = condLeft.Count + ":" + condRight.Count;

        var genCell = new GenericMutatorCell { Total = 5 };
        ProbeGenericMutating(ref genCell);

        ILogMutator origMut = new ClassMutator("orig");
        ILogMutator replMut = new ClassMutator("repl");
        var origRef = origMut;
        ProbeGenericClassReplace(ref origRef, replMut);
        var genClassRes = ((ClassMutator)origMut).Tag + "|" + ((ClassMutator)origRef).Tag;

        var byValExt = new ByValExtStruct { X = 10 };
        var byValExtRes = byValExt.Probe() + ":" + byValExt.X;

        var outerCastRes = ((IHasVal)(LibStructHandler)$"{3}").GetVal();
        var inLongRes = AcceptInLong(99, $"{1}");
        var paramsAppendRes = AcceptParamsAppend($"ab{1 + 2}cd");

        var callerInfoRes = AcceptCallerInfo($"{1 + 2}");

        var incHolder = new IncDecIndexerHolder();
        incHolder[true, $"{incHolder.Next()}"]++;
        int afterStmtPostInc = incHolder[true, $"{0}"];
        var valPostInc = incHolder[true, $"{incHolder.Next()}"]++;
        var valPreInc = ++incHolder[true, $"{incHolder.Next()}"];
        --incHolder[true, $"{incHolder.Next()}"];
        var valPostDec = incHolder[true, $"{incHolder.Next()}"]--;
        int incNextCalls = incHolder.NextCalls;

        NullFlowTarget? target = null;
        string nullPlain = "no";
        try {
            target!.PlainLog($"{PlainHole()}");
        } catch (NullReferenceException) {
            nullPlain = "pl:" + NullFlowTarget.PlainHoleCalls;
        }
        string nullCall = "no";
        try {
            target!.Log(1, $"{2}", After());
        } catch (NullReferenceException) {
            nullCall = "c:" + NullFlowTarget.AfterCalls;
        }
        string nullParams = "no";
        try {
            target!.LogParams(1, $"{2}", ParamsAfter(), ParamsAfter());
        } catch (NullReferenceException) {
            nullParams = "p:" + NullFlowTarget.ParamsAfterCalls;
        }
        string nullAssignStmt = "no";
        try {
            target![true, $"{1}"] = TouchRhs();
        } catch (NullReferenceException) {
            nullAssignStmt = "s:" + NullFlowTarget.RhsCalls;
        }
        string nullAssignExpr = "no";
        try {
            var ignored = target![true, $"{1}"] = TouchRhs();
        } catch (NullReferenceException) {
            nullAssignExpr = "e:" + NullFlowTarget.RhsCalls;
        }
        string nullConvStmt = "no";
        try {
            target![1, $"{1}"] = MakeConvertible();
        } catch (NullReferenceException) {
            nullConvStmt = "cs:" + ConvertibleInt.Conversions;
        }
        string nullConvExpr = "no";
        try {
            var convVal = target![1, $"{1}"] = MakeConvertible();
        } catch (NullReferenceException) {
            nullConvExpr = "ce:" + ConvertibleInt.Conversions;
        }

        return roCount + "|" + roLocalCount + "|" + defCopyRes + "|" + postIncArgRes + "|" + promotedRefRes + "|" + container.Cell.Count + "|" + sameBox + "|" +
            outVarRes + "|" + outExistingRes + "|" + spanLit + "|" + baseCtorSeen + "|" + ungatedRes + "|" +
            condExtRes + "|" + namedDelegateRes + "|" +
            afterFalseGated + "," + afterTrueGated + "|" + pairAfterFalse + "," + pairAfterTrue + "|" +
            deconstructOrderRes + "|" + ordCompoundRes + "|" + unqualOutRes + "|" + roRefArgRes + "|" + condBaseRes + "|" + refNonNullRes + "|" + refIdxRes + "|" + refIdxRhsOrderRes + "|" + refCondRes + "|" + genCell.Total + "|" + genClassRes + "|" + byValExtRes + "|" + outerCastRes + "|" + inLongRes + "|" + paramsAppendRes + "|" + callerInfoRes + "|" +
            afterStmtPostInc + "," + valPostInc + "," + valPreInc + "," + valPostDec + "," + incNextCalls + "|" +
            nullPlain + "|" + nullCall + "|" + nullParams + "|" + nullAssignStmt + "|" + nullAssignExpr + "|" + nullConvStmt + "|" + nullConvExpr;
    }
}
`, library: `
using System.Runtime.CompilerServices;
namespace RefIdxLib;

[InterpolatedStringHandler]
public ref struct LibRefIdxHandler {
    public LibRefIdxHandler(int literalLength, int formattedCount) { }
    public void AppendFormatted(int value) { }
}

public interface IHasVal {
    int GetVal();
}

[InterpolatedStringHandler]
public struct LibStructHandler : IHasVal {
    public int Seen;
    public LibStructHandler(int literalLength, int formattedCount) { Seen = 0; }
    public void AppendFormatted(int v) { Seen += v; }
    public int GetVal() => Seen * 10 + 1;
}

public struct RefIndexerCell {
    public int Index;
    public int[] Slots;
    public readonly ref int this[LibRefIdxHandler h] => ref Slots[Index];
}
`, strictIl: true, expectedOutput: "5|8|102|7:8:8|init->after:init:1|5|True|99:42|99:42|lit-9|55|4:5|53|3:7|10,12|0,2:20:21|5:30:31:1:2|HR:22:21:4:5|141:0|61|other<-D:self:self;B:self:self|nf:8|0:77|88:0:88|21:41|8|orig:123|repl|11:60|31|99|ab#3cd|1 + 2=3@True|12,12,14,13,5|pl:1|c:1|p:2|s:1|e:2|cs:1|ce:2")
    }

    @Fact
    func TopLevelStatementsAndMain_AndUnsupportedDiagnostics_BehaveAsDocumented() {
        // 1. Top-level statements (Program.cs) with ref struct handlers, standalone expression,
        //    coordinated indexer assignment/increment, out-var across frame, deconstruction,
        //    pattern variables in conditions, and top-level await.
        let topLevelSource = `
using System;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading.Tasks;

Accept($"top={1}");
var sb = new StringBuilder();
sb.Append($",sb={2}");
Console.Write(sb.ToString());
Console.Write(((TopHandler)$",expr={3}").ToString());
var standaloneLocal = ((TopHandler)$",loc={4}").ToString();
Console.Write(standaloneLocal);

var holder = new TopHolder();
holder[true, $"a={5}"] = 20;
var assignExpr = holder[true, $"b={6}"] = 30;
holder[true, $"c={7}"]++;
Console.Write($",{assignExpr},{holder.LastValue}");

var ok = TryTop($"o={8}", out var outN);
Console.Write($",{ok},{outN}");
if (TryTop($"c={9}", out var outM)) {
    Console.Write($",{outM}");
}
(var da, var db) = PairTop($"p={10}");
Console.Write($",{da},{db}");

if (GetNullableInt($"g={11}") is int patN) {
    Console.Write($",{patN}");
}
bool condFlag = true;
if (condFlag && GetNullableInt($"h={12}") is int patM) {
    Console.Write($",{patM}");
}
var awaitedVal = await GetAsyncTop($"w={13}");
Console.Write($",{awaitedVal}");
var nestedStandaloneArg = UseTop($"u={14}", ((TopHandler)$"s={15}").ToString());
Console.Write($",{nestedStandaloneArg}");

static void Accept(TopHandler h) => Console.Write(h.ToString());
static string UseTop(TopHandler h, string extra) => h.ToString() + ":" + extra;
static bool TryTop(TopHandler h, out int len) { len = h.ToString().Length; return true; }
static (string, int) PairTop(TopHandler h) => (h.ToString(), h.ToString().Length);
static int? GetNullableInt(TopHandler h) => h.ToString().Length;
static Task<int> GetAsyncTop(TopHandler h) => Task.FromResult(h.ToString().Length);

public sealed class TopHolder {
    public int LastValue;
    public int this[bool flag, TopHandler h] {
        get => LastValue;
        set => LastValue = value + h.ToString().Length;
    }
}

[InterpolatedStringHandler]
public ref struct TopHandler {
    private readonly StringBuilder sb;
    public TopHandler(int literalLength, int formattedCount) { sb = new StringBuilder(); }
    public void AppendLiteral(string text) { sb.Append(text); }
    public void AppendFormatted(int value) { sb.Append(value); }
    public override string ToString() => sb.ToString();
}
`
        let topProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("Program.cs", topLevelSource)},
            outputKind: OutputKind.ConsoleApplication
        )
        Assert.True(topProject.BoundWithoutErrors)
        let topDoc = topProject.Documents[0]
        let topCtx = TranslationContext(topProject.Compilation, topDoc.SemanticModel, topDoc.FilePath)
        let topPrinted = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(topDoc, topCtx))
        Assert.DoesNotContain(topCtx.Diagnostics, (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info)
        Assert.Equal("top=1,sb=2,expr=3,loc=4,30,37,True,3,3,p=10,4,4,4,4,u=14:s=15", CompileAndRunTopLevel(topPrinted))

        // 2. Explicit Main hoisted to top level with:
        //    - ref struct handler
        //    - static readonly struct field receiver forwarding (ordinary struct handler, IsReadOnlyRefAlias)
        //    - standalone expression
        //    - coordinated indexer assignment
        let mainSource = `
using System;
using System.Runtime.CompilerServices;
using System.Text;

[InterpolatedStringHandler]
public ref struct MainHandler {
    private readonly StringBuilder sb;
    public MainHandler(int literalLength, int formattedCount) { sb = new StringBuilder(); }
    public void AppendLiteral(string text) { sb.Append(text); }
    public void AppendFormatted(int value) { sb.Append(value); }
    public override string ToString() => sb.ToString();
}

[InterpolatedStringHandler]
public struct MainReadOnlyReceiverHandler {
    public readonly int Sum;
    public MainReadOnlyReceiverHandler(int literalLength, int formattedCount, in MainCell cell) {
        Sum = cell.Seed + literalLength + formattedCount;
    }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}

public struct MainCell {
    public int Seed;
    public string Log([InterpolatedStringHandlerArgument("")] MainReadOnlyReceiverHandler h) => "ro=" + h.Sum;
}

public sealed class MainHolder {
    public string Stored = "";
    public string this[MainHandler h] {
        get => Stored;
        set => Stored = h.ToString() + "=" + value;
    }
}

public static class Program {
    private static readonly MainCell Cell = new MainCell { Seed = 10 };
    private static void Accept(MainHandler h) => Console.Write(h.ToString());
    public static void Main() {
        Accept($"main={7}");
        Console.Write("|" + Cell.Log($"x={1}"));
        Console.Write("|" + ((MainHandler)$"standalone={8}").ToString());
        var mh = new MainHolder();
        mh[$"k={9}"] = "v";
        Console.Write("|" + mh.Stored);
    }
}
`
        let mainProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("Program.cs", mainSource)},
            outputKind: OutputKind.ConsoleApplication
        )
        Assert.True(mainProject.BoundWithoutErrors)
        let mainDoc = mainProject.Documents[0]
        let mainCtx = TranslationContext(mainProject.Compilation, mainDoc.SemanticModel, mainDoc.FilePath)
        let mainPrinted = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(mainDoc, mainCtx))
        Assert.DoesNotContain(mainCtx.Diagnostics, (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info)
        Assert.Equal("main=7|ro=13|standalone=8|k=9=v", CompileAndRunTopLevel(mainPrinted))

        // 3. Coordinated handler inside : this(...) ctor initializer reports located unsupported diagnostic.
        let ctorInitTree = CSharpSyntaxTree.ParseText(`
using System.Runtime.CompilerServices;
[InterpolatedStringHandler]
public ref struct CtorInitHandler {
    public CtorInitHandler(int literalLength, int formattedCount, int seed) { }
    public void AppendFormatted(int value) { }
}
public sealed class CtorHolder {
    public CtorHolder(int seed, [InterpolatedStringHandlerArgument("seed")] CtorInitHandler h) { }
    public CtorHolder() : this(1, $"{2}") { }
}
`, path: "CtorInit.cs")
        let ctorComp = CSharpCompilation.Create(
            "CtorInitTest",
            []SyntaxTree{ctorInitTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let ctorModel = ctorComp.GetSemanticModel(ctorInitTree)
        let ctorCtx = TranslationContext(ctorComp, ctorModel, ctorInitTree.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(ctorInitTree.FilePath, ctorInitTree, ctorModel),
            ctorCtx
        )
        Assert.Contains(
            ctorCtx.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message?.Contains(
                "constructor initializer",
                StringComparison.OrdinalIgnoreCase
            ) == true
        )

        // 4. Dynamic append call reports located unsupported diagnostic rather than selecting wrong overload.
        let dynTree = CSharpSyntaxTree.ParseText(`
using System.Runtime.CompilerServices;
[InterpolatedStringHandler]
public ref struct DynamicOverloadHandler {
    public DynamicOverloadHandler(int literalLength, int formattedCount) { }
    public void AppendFormatted(int value) { }
    public void AppendFormatted(object? value) { }
}
public static class DynDemo {
    private static void Accept(DynamicOverloadHandler h) { }
    public static void Probe(dynamic d) { Accept($"{d}"); }
}
`, path: "DynamicAppend.cs")
        let dynComp = CSharpCompilation.Create(
            "DynamicAppendTest",
            []SyntaxTree{dynTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let dynModel = dynComp.GetSemanticModel(dynTree)
        let dynCtx = TranslationContext(dynComp, dynModel, dynTree.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(dynTree.FilePath, dynTree, dynModel),
            dynCtx
        )
        Assert.Contains(
            dynCtx.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message?.Contains(
                "dynamic",
                StringComparison.OrdinalIgnoreCase
            ) == true
        )

        // 5. Unframeable top-level ref-struct handler local reports located unsupported diagnostic.
        let topLocalProject = CSharpProjectLoader.LoadInMemory([](string, source string){("Program.cs", `
using System.Runtime.CompilerServices;
var h = (TopRefLocal)$"{1}";
[InterpolatedStringHandler]
public ref struct TopRefLocal {
    public TopRefLocal(int literalLength, int formattedCount) { }
    public void AppendFormatted(int value) { }
}
`)}, outputKind: OutputKind.ConsoleApplication)
        Assert.True(topLocalProject.BoundWithoutErrors)
        let topLocalDoc = topLocalProject.Documents[0]
        let topLocalCtx = TranslationContext(
            topLocalProject.Compilation,
            topLocalDoc.SemanticModel,
            topLocalDoc.FilePath
        )
        let _ = CSharpToGSharpTranslator().TranslateDocument(topLocalDoc, topLocalCtx)
        Assert.Contains(
            topLocalCtx.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message?.Contains(
                "top-level",
                StringComparison.OrdinalIgnoreCase
            ) == true
        )

        // 6. Collection initializer Add(...) with receiver placeholder reports unsupported rather than using enclosing `this` or an outer call's receiver.
        let collInitTree = CSharpSyntaxTree.ParseText(`
using System.Collections;
using System.Runtime.CompilerServices;
[InterpolatedStringHandler]
public ref struct BagHandler {
    public BagHandler(int literalLength, int formattedCount, Bag owner) { }
    public void AppendFormatted(int v) { }
}
public sealed class Bag : IEnumerable {
    public void Add([InterpolatedStringHandlerArgument("")] BagHandler h) { }
    public void Log([InterpolatedStringHandlerArgument("")] BagHandler h, Bag nested) { }
    public Bag Make() => new Bag { $"{1}" };
    public void MakeNested(Bag bag) => bag.Log($"{1}", new Bag { $"{2}" });
    public IEnumerator GetEnumerator() => null!;
}
`, path: "BagInit.cs")
        let collComp = CSharpCompilation.Create(
            "BagInitTest",
            []SyntaxTree{collInitTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let collModel = collComp.GetSemanticModel(collInitTree)
        let collCtx = TranslationContext(collComp, collModel, collInitTree.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(collInitTree.FilePath, collInitTree, collModel),
            collCtx
        )
        Assert.Equal(
            2,
            collCtx.Diagnostics.Count(
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message?.Contains(
                    "receiver placeholder",
                    StringComparison.OrdinalIgnoreCase
                ) == true
            )
        )

        // 7. Top-level ref-returning coordinated handler call reports located unsupported diagnostic.
        let topRefRetProject = CSharpProjectLoader.LoadInMemory([](string, source string){("Program.cs", `
using System.Runtime.CompilerServices;
var slots = new int[2];
SetRefTop(ref SlotTop(slots, $"r={1}"));
static ref int SlotTop(int[] arr, TopRefRetHandler h) => ref arr[0];
static void SetRefTop(ref int slot) { slot = 77; }
[InterpolatedStringHandler]
public ref struct TopRefRetHandler {
    public TopRefRetHandler(int literalLength, int formattedCount) { }
    public void AppendLiteral(string t) { }
    public void AppendFormatted(int v) { }
}
`)}, outputKind: OutputKind.ConsoleApplication)
        Assert.True(topRefRetProject.BoundWithoutErrors)
        let topRefRetDoc = topRefRetProject.Documents[0]
        let topRefRetCtx = TranslationContext(
            topRefRetProject.Compilation,
            topRefRetDoc.SemanticModel,
            topRefRetDoc.FilePath
        )
        let _ = CSharpToGSharpTranslator().TranslateDocument(topRefRetDoc, topRefRetCtx)
        Assert.Contains(
            topRefRetCtx.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message?.Contains(
                "ref-returning",
                StringComparison.OrdinalIgnoreCase
            ) == true
        )
    }

    private func CompileAndRunTopLevel(printedProgram string) string {
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5965-toplevel", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(workDir)
        try {
            let gsPath = Path.Combine(workDir, "Program.gs")
            let dllPath = Path.Combine(workDir, "Program.dll")
            File.WriteAllText(gsPath, printedProgram)
            let compilerPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
            let (compileExit, compileOut) = RunDotnetProcess(
                "\"$compilerPath\" /target:exe /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc failed:\n" + compileOut + "\n\nTranslated:\n" + printedProgram
            )
            let (runExit, runOut) = RunDotnetProcess("\"$dllPath\"")
            Assert.Equal(0, runExit)
            return runOut
        } finally {
            if Directory.Exists(workDir) {
                Directory.Delete(workDir, recursive: true)
            }
        }
    }

    private func RunDotnetProcess(arguments string)(Exit int32, Output string) {
        let psi = ProcessStartInfo("dotnet", arguments){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        using let process = Process.Start(psi)!!
        let stdout = process.StandardOutput.ReadToEndAsync()
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(TimeSpan.FromMinutes(5)) {
            process.Kill(entireProcessTree: true)
            Assert.Fail("dotnet " + arguments + " did not exit within 5 minutes.")
        }
        return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
    }
}
