// <copyright file="Issue5965InterpolatedStringHandlerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
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
}
