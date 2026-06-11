// <copyright file="InterpolatedStringHandlerFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;
using System.Text;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>
/// Issue #368 fixtures: user-defined <c>[InterpolatedStringHandler]</c> types and
/// consuming APIs that exercise <c>[InterpolatedStringHandlerArgument]</c>
/// forwarding (a named preceding argument, the receiver, and the <c>out bool</c>
/// short-circuit form). Defined in the test (fixture) assembly so a G# program
/// can <c>import GSharp.Core.Tests.Fixtures</c> and pass an interpolated string
/// to these handler parameters.
/// </summary>
[InterpolatedStringHandler]
public struct PrefixedInterpolatedStringHandler
{
    private readonly StringBuilder builder;

    public PrefixedInterpolatedStringHandler(int literalLength, int formattedCount, string prefix)
    {
        this.builder = new StringBuilder(prefix.Length + literalLength);
        this.builder.Append(prefix);
    }

    public void AppendLiteral(string s) => this.builder.Append(s);

    public void AppendFormatted<T>(T value) => this.builder.Append(value?.ToString());

    public void AppendFormatted<T>(T value, int alignment)
    {
        var text = value?.ToString() ?? string.Empty;
        this.builder.Append(alignment < 0 ? text.PadRight(-alignment) : text.PadLeft(alignment));
    }

    public override string ToString() => this.builder.ToString();
}

/// <summary>
/// Issue #368 fixture: a handler whose constructor forwards the receiver
/// (the empty-string <c>[InterpolatedStringHandlerArgument("")]</c> form).
/// </summary>
[InterpolatedStringHandler]
public struct ReceiverInterpolatedStringHandler
{
    private readonly StringBuilder builder;

    public ReceiverInterpolatedStringHandler(int literalLength, int formattedCount, InterpolationLog log)
    {
        this.builder = log.Buffer;
    }

    public void AppendLiteral(string s) => this.builder.Append(s);

    public void AppendFormatted<T>(T value) => this.builder.Append(value?.ToString());
}

/// <summary>
/// Issue #368 fixture: a handler whose constructor declares an
/// <c>out bool shouldAppend</c> short-circuit parameter (set from a threshold)
/// and whose append methods are unconditional.
/// </summary>
[InterpolatedStringHandler]
public struct GatedInterpolatedStringHandler
{
    private readonly StringBuilder builder;

    public GatedInterpolatedStringHandler(int literalLength, int formattedCount, bool enabled, out bool shouldAppend)
    {
        this.builder = new StringBuilder(literalLength);
        shouldAppend = enabled;
    }

    public void AppendLiteral(string s) => this.builder.Append(s);

    public void AppendFormatted<T>(T value) => this.builder.Append(value?.ToString());

    public override string ToString() => this.builder?.ToString() ?? "<gated>";
}

/// <summary>A mutable buffer used by <see cref="ReceiverInterpolatedStringHandler"/> forwarding.</summary>
public sealed class InterpolationLog
{
    public InterpolationLog() => this.Buffer = new StringBuilder();

    public StringBuilder Buffer { get; }

    public string Append([InterpolatedStringHandlerArgument("")] ReceiverInterpolatedStringHandler handler)
        => this.Buffer.ToString();

    public override string ToString() => this.Buffer.ToString();
}

/// <summary>Static consuming APIs for the issue #368 handler fixtures.</summary>
public static class InterpolationHarness
{
    /// <summary>
    /// Issue #418 (P1-9): observes side effects of interpolated-string hole
    /// expressions. Tests increment this counter inside a hole and then verify
    /// it stays at zero when the handler gate (shouldAppend = false) skips
    /// the appends — proving holes are evaluated lazily, after the ctor.
    /// </summary>
    public static int HoleEvaluations;

    public static int BumpAndReturn(int value)
    {
        System.Threading.Interlocked.Increment(ref HoleEvaluations);
        return value;
    }

    public static System.Threading.Tasks.Task<int> BumpAndReturnAsync(int value)
    {
        System.Threading.Interlocked.Increment(ref HoleEvaluations);
        return System.Threading.Tasks.Task.FromResult(value);
    }

    public static void ResetHoleEvaluations() => HoleEvaluations = 0;

    public static string Format(string prefix, [InterpolatedStringHandlerArgument("prefix")] PrefixedInterpolatedStringHandler handler)
        => handler.ToString();

    public static string Gated(bool enabled, [InterpolatedStringHandlerArgument("enabled")] GatedInterpolatedStringHandler handler)
        => handler.ToString();

    public static string Typed(string prefix, [InterpolatedStringHandlerArgument("prefix")] TypedAppendInterpolatedStringHandler handler)
        => handler.ToString();
}

/// <summary>
/// Issue #377 sub-item 1 fixture: a method that accepts the handler by `ref`.
/// Mirrors the BCL pattern used by APIs like
/// <c>StringBuilder.Append(ref AppendInterpolatedStringHandler)</c> where the
/// handler is a `ref struct` and must be passed by-ref.
/// </summary>
public static class ByRefHandlerHarness
{
    public static string AppendRef(string prefix, [InterpolatedStringHandlerArgument("prefix")] ref PrefixedInterpolatedStringHandler handler)
        => handler.ToString();

    public static string AppendIn(string prefix, [InterpolatedStringHandlerArgument("prefix")] in PrefixedInterpolatedStringHandler handler)
        => handler.ToString();
}

/// <summary>
/// Issue #377 sub-item 2 fixture: a counter exposed to handler-forwarded
/// arguments so a hosting test can observe how many times the source
/// expression was evaluated. C# §11.18.1 mandates exactly-once evaluation;
/// G# pre-#377 re-evaluated forwarded args inside the handler constructor.
/// </summary>
public static class ForwardCounter
{
    public static int InvocationCount;

    public static string IncrementAndReturn(string value)
    {
        System.Threading.Interlocked.Increment(ref InvocationCount);
        return value;
    }

    public static void Reset() => InvocationCount = 0;
}

/// <summary>
/// Issue #377 sub-item 4 fixture: two static overloads — one taking
/// <see cref="object"/>, one taking <see cref="System.FormattableString"/>.
/// Tests pass an interpolated string and verify the
/// <c>FormattableString</c> overload wins (matching C# §11.18.1's "more
/// specific target" rule).
/// </summary>
public static class FormattableOverloadHarness
{
    public static string LastChosen = string.Empty;

    public static string ChooseObject(object value)
    {
        LastChosen = "object:" + (value?.ToString() ?? "<null>");
        return LastChosen;
    }

    public static string ChooseObject(System.FormattableString value)
    {
        LastChosen = "formattable:" + value.Format;
        return LastChosen;
    }

    public static void Reset() => LastChosen = string.Empty;
}

/// <summary>
/// Issue #377 sub-item 5 fixture: a single overload taking
/// <see cref="System.FormattableString"/>. Tests pass an interpolated string
/// through a named argument (e.g. <c>M(f: $"…")</c>) and verify target
/// typing flows through the named-argument reorder.
/// </summary>
public static class FormattableNamedArgHarness
{
    public static string LastFormat = string.Empty;

    public static string AcceptNamed(System.FormattableString f)
    {
        LastFormat = f.Format;
        return f.ToString();
    }

    public static void Reset() => LastFormat = string.Empty;
}

/// <summary>
/// Issue #418 (P1-10) fixture: a handler whose <c>AppendFormatted</c> overloads
/// are deliberately type-discriminated so the lowerer's overload resolution can
/// be observed. Each overload tags its appended text so a test can assert which
/// one was picked for a given hole's static type.
/// </summary>
[InterpolatedStringHandler]
public struct TypedAppendInterpolatedStringHandler
{
    private readonly StringBuilder builder;

    public TypedAppendInterpolatedStringHandler(int literalLength, int formattedCount, string prefix)
    {
        this.builder = new StringBuilder(prefix.Length + literalLength);
        this.builder.Append(prefix);
    }

    public void AppendLiteral(string s) => this.builder.Append(s);

    public void AppendFormatted(int value) => this.builder.Append("[int:").Append(value).Append(']');

    public void AppendFormatted(string value) => this.builder.Append("[str:").Append(value).Append(']');

    public void AppendFormatted<T>(T value) => this.builder.Append("[T:").Append(value?.ToString()).Append(']');

    public override string ToString() => this.builder.ToString();
}
