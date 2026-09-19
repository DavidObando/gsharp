// <copyright file="GeneratedRegexMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The resolved attribute knobs for an <c>@GeneratedRegex</c> bodyless
/// <c>func</c> declaration (ADR-0187 / issue #4301). Attached to a
/// <see cref="FunctionSymbol"/> by the declaration binder when the
/// declaration is well-formed; the emitter consumes the payload to
/// initialize <see cref="FunctionSymbol.GeneratedRegexBackingField"/> in the
/// declaring type's <c>.cctor</c> (a cached <c>Regex</c> instance, matching
/// the real C# source-generator's shape) and to synthesize the trivial
/// <c>return &lt;backing field&gt;</c> method body.
/// </summary>
public sealed record GeneratedRegexMetadata
{
    /// <summary>Initializes a new instance of the <see cref="GeneratedRegexMetadata"/> class.</summary>
    /// <param name="pattern">The regular-expression pattern (required positional argument).</param>
    /// <param name="optionsValue">The resolved <c>RegexOptions</c> bit-field, as its underlying <c>int32</c> value.</param>
    /// <param name="hasMatchTimeout">Whether an explicit <c>matchTimeoutMilliseconds</c> argument was supplied.</param>
    /// <param name="matchTimeoutMilliseconds">The <c>matchTimeoutMilliseconds</c> value; <c>-1</c> denotes <c>Regex.InfiniteMatchTimeout</c>. Ignored when <paramref name="hasMatchTimeout"/> is <c>false</c>.</param>
    /// <param name="cultureName">The <c>cultureName</c> argument, or an empty string when unset.</param>
    public GeneratedRegexMetadata(
        string pattern,
        int optionsValue,
        bool hasMatchTimeout,
        int matchTimeoutMilliseconds,
        string cultureName)
    {
        Pattern = pattern;
        OptionsValue = optionsValue;
        HasMatchTimeout = hasMatchTimeout;
        MatchTimeoutMilliseconds = matchTimeoutMilliseconds;
        CultureName = cultureName;
    }

    /// <summary>Gets the regular-expression pattern. Required.</summary>
    public string Pattern { get; }

    /// <summary>Gets the resolved <c>System.Text.RegularExpressions.RegexOptions</c> bit-field.</summary>
    public int OptionsValue { get; }

    /// <summary>Gets a value indicating whether an explicit <c>matchTimeoutMilliseconds</c> argument was supplied.</summary>
    public bool HasMatchTimeout { get; }

    /// <summary>
    /// Gets the <c>matchTimeoutMilliseconds</c> value. <c>-1</c> denotes
    /// <c>Regex.InfiniteMatchTimeout</c> (value-equal to
    /// <c>TimeSpan.FromMilliseconds(-1)</c>, so no special-cased field
    /// reference is needed at construction time). Ignored when
    /// <see cref="HasMatchTimeout"/> is <c>false</c> — the two-argument
    /// <c>Regex(string, RegexOptions)</c> constructor is used instead, so
    /// the process-wide default match timeout (<c>AppContext</c> switch
    /// <c>REGEX_DEFAULT_MATCH_TIMEOUT</c>) applies exactly as it would for
    /// C#'s generated code.
    /// </summary>
    public int MatchTimeoutMilliseconds { get; }

    /// <summary>Gets the <c>cultureName</c> argument, or an empty string when unset.</summary>
    public string CultureName { get; }
}
