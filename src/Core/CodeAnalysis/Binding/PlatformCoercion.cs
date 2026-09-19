// <copyright file="PlatformCoercion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0186 §4: the runtime nil check inserted wherever a platform value
/// <c>T!</c> is coerced into a destination whose declared type is a non-null
/// reference type.
/// <para>
/// <b>One rule, one implementation.</b> §4's specification is a single
/// sentence, and the ADR is emphatic that the list of concrete sites beneath
/// it is <em>consequence, not an additional list</em>. Keeping the insertion
/// in one helper is how that stays true: a second copy is how ADR-0136's
/// carve-out predicates began, and failure mode 1 of the catalogue is
/// literally "the read path and the call path drifted".
/// </para>
/// <para>
/// The check reuses the existing <c>!!</c> lowering
/// (<c>dup; brtrue; pop; newobj NullReferenceException; throw</c>) rather than
/// inventing a node kind, which is deliberate: it inherits every lowering
/// stage, spiller and rewriter the operator already passes through, and the
/// exception type stays the one existing <c>catch</c> clauses in both G# and
/// interop code already expect. The whole improvement over an unattributed
/// NRE is the <em>message</em>.
/// </para>
/// </summary>
internal static class PlatformCoercion
{
    /// <summary>
    /// Wraps <paramref name="expression"/> in ADR-0186 §4's check when it is
    /// platform-typed, and returns it unchanged otherwise.
    /// </summary>
    /// <param name="expression">The platform-typed value being coerced.</param>
    /// <param name="location">The coercion site, for the message.</param>
    /// <param name="boundary">
    /// A short phrase naming the boundary the value crossed — "an argument to
    /// a non-null parameter", "a member access receiver". It is what turns an
    /// NRE into an attributable one, which is §4's entire justification for
    /// preferring a call-site check over the CLR's own.
    /// </param>
    /// <param name="suppressible">
    /// Whether <c>--platform-nil-checks=off</c> may remove this check. True
    /// for every check the compiler INSERTS; false for the one the author
    /// WROTE (a user <c>!!</c> over a platform operand, which §6 calls the
    /// explicit spelling of the same coercion). The switch governs insertion,
    /// never an assertion already in the source.
    /// </param>
    /// <returns>The checked expression, or the original.</returns>
    internal static BoundExpression InsertCheck(
        BoundExpression expression,
        TextLocation? location,
        string boundary,
        bool suppressible = true)
    {
        if (expression.Type is not PlatformTypeSymbol platform)
        {
            return expression;
        }

        // `--platform-nil-checks=off` suppresses the CHECK. It must not
        // suppress the UNWRAP, and the two were coupled here at first: this
        // helper is also §5's mechanism — replacing a platform receiver with
        // one typed at the bare underlying is what makes member lookup run
        // against `T` by construction — so returning the still-wrapped
        // expression turned working indexer and `for … in` code into GS0116
        // "not indexable" compile errors under a switch whose entire purpose
        // is to remove a runtime check for measurement.
        //
        // A conversion node carries the unwrap with no IL of its own: the
        // emitter's second arm tests
        // `AreRuntimeEquivalentIgnoringReferenceNullability`, which strips a
        // platform wrapper by design (§1 — `T!` and `T` genuinely are one
        // runtime type), so this lowers to the operand and nothing else.
        if (suppressible && !NullabilityOptions.PlatformNilChecksEnabled)
        {
            return new BoundConversionExpression(
                expression.Syntax,
                platform.UnderlyingType,
                expression);
        }

        var check = BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, platform);
        if (check == null)
        {
            return expression;
        }

        return new BoundUnaryExpression(
            expression.Syntax,
            check,
            expression,
            isChecked: false,
            platformCheckMessage: BuildMessage(expression, platform, location, boundary));
    }

    /// <summary>
    /// ADR-0186 §4's message shape: <c>"&lt;expr&gt; was nil
    /// (nullability-oblivious value from &lt;origin&gt;) at
    /// &lt;file&gt;:&lt;line&gt;"</c>.
    /// </summary>
    /// <param name="expression">The checked expression.</param>
    /// <param name="platform">Its platform type.</param>
    /// <param name="location">The coercion site.</param>
    /// <param name="boundary">The boundary phrase.</param>
    /// <returns>The exception message.</returns>
    private static string BuildMessage(
        BoundExpression expression,
        PlatformTypeSymbol platform,
        TextLocation? location,
        string boundary)
    {
        // Failure mode 3 of ADR-0186's catalogue was a safety check gated on
        // having receiver syntax available TO QUOTE IN A MESSAGE: a chained
        // call's intermediate receivers are bound with a null `Syntax`, so
        // `s.ToUpper().Trim()` skipped the check entirely while `s.ToUpper()`
        // did not. The lesson is not "find better syntax" but "a message
        // formatting detail must never decide whether a check runs" — so the
        // text degrades and the check is unconditional.
        var description = DescribeExpression(expression) ?? $"a {platform.Name} value";
        var origin = DescribeOrigin(platform);
        var at = DescribeLocation(location);
        return $"{description} was nil ({origin}), coerced at {boundary}{at}.";
    }

    /// <summary>Renders the source text of an expression, when it has any.</summary>
    /// <param name="expression">The checked expression.</param>
    /// <returns>The quoted source text, or <see langword="null"/>.</returns>
    private static string? DescribeExpression(BoundExpression expression)
    {
        var syntax = expression.Syntax;
        var text = syntax?.Location.Text;
        if (syntax == null || text == null)
        {
            return null;
        }

        var span = syntax.Location.Span;
        if (span.Length <= 0 || span.End > text.Length)
        {
            return null;
        }

        var source = text.ToString(span).Trim();

        // A long or multi-line expression makes an unreadable exception
        // message; the file:line below already locates it exactly.
        if (source.Length == 0 || source.Length > 80 || source.Contains('\n'))
        {
            return null;
        }

        return "'" + source + "'";
    }

    /// <summary>
    /// Names what kind of value failed. This is the half of the message a
    /// reader actually needs: the value is not nil because the program is
    /// wrong, but because nobody ever stated whether it could be.
    /// <para>
    /// ADR-0186 §4's sketch writes this as "from &lt;origin&gt;", meaning the
    /// oblivious <em>declaration</em>. That is deliberately not rendered as an
    /// assembly name here, because the only assembly reachable from a
    /// <see cref="PlatformTypeSymbol"/> is the one declaring <c>T</c> itself —
    /// <c>System.Runtime</c> for a <c>string!</c> — which names the wrong
    /// thing and would actively mislead. The declaring member is not in reach
    /// at the coercion point; naming the type and the boundary is the honest
    /// subset, and the file:line that follows locates the rest.
    /// </para>
    /// </summary>
    /// <param name="platform">The platform type.</param>
    /// <returns>The origin phrase.</returns>
    private static string DescribeOrigin(PlatformTypeSymbol platform)
        => $"a nullability-oblivious {platform.Name}";

    /// <summary>Renders the coercion site as <c>file:line</c>.</summary>
    /// <param name="location">The coercion site.</param>
    /// <returns>The rendered suffix, or the empty string.</returns>
    private static string DescribeLocation(TextLocation? location)
    {
        if (location is not { } present || present.Text is not { } text || present.Span.Start > text.Length)
        {
            return string.Empty;
        }

        // Only the file NAME, never the full path: the message is baked into
        // the emitted assembly as a user string, and a build-machine absolute
        // path there would break deterministic/reproducible builds.
        var file = present.FileName is { Length: > 0 } fileName
            ? Path.GetFileName(fileName)
            : "<unknown>";
        return $" in {file}:{present.StartLine + 1}";
    }
}
