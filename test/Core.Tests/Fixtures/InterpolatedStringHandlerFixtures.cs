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
    public static string Format(string prefix, [InterpolatedStringHandlerArgument("prefix")] PrefixedInterpolatedStringHandler handler)
        => handler.ToString();

    public static string Gated(bool enabled, [InterpolatedStringHandlerArgument("enabled")] GatedInterpolatedStringHandler handler)
        => handler.ToString();
}
