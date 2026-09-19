// <copyright file="GeneratedRegexBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0187 / issue #4301: recognizes and validates <c>@GeneratedRegex</c> —
/// the third attribute discriminator on a bodyless <c>func</c> declaration
/// alongside <c>@DllImport</c>/<c>@LibraryImport</c> (ADR-0086 §1 /
/// ADR-0092). Unlike P/Invoke, which synthesizes a second stateless hidden
/// method, <c>@GeneratedRegex</c> needs cached STATE — a <c>Regex</c>
/// instance built once and returned on every call — so instead of an
/// <c>ImplMap</c>/marshalling-stub shape, this borrows ADR-0051's
/// auto-property backing-field synthesis: a private, <c>shared</c>/static
/// <c>Regex</c>-typed field, initialized once in the declaring type's
/// <c>.cctor</c>, with the annotated function's body reduced to a trivial
/// <c>return &lt;field&gt;</c>.
/// </summary>
/// <remarks>
/// The semantic contract mirrors cs2gs's <c>TryTranslateGeneratedRegex</c>
/// (<c>tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Members.cs</c>),
/// the authoritative reference for every rule that must carry over from real
/// <c>[GeneratedRegex]</c> semantics: a required constant <c>pattern</c>, an
/// optional <c>options</c>, an optional <c>matchTimeoutMilliseconds</c>
/// (<c>-1</c> denotes <c>Regex.InfiniteMatchTimeout</c>), an optional
/// <c>cultureName</c>, and the culture-sensitive-<c>IgnoreCase</c>
/// restriction. That function extracts from Roslyn <c>AttributeData</c>;
/// this one extracts from gsc's own bound <see cref="BoundAttribute"/>
/// arguments, which are already-resolved compile-time constants (ADR-0047
/// §3) — no Roslyn, no source-text synthesis, and no new bound-tree node
/// kind (mirroring ADR-0092's "no new BoundNodeKind" consequence): the
/// initializer is built directly from
/// <see cref="BoundClrConstructorCallExpression"/> /
/// <see cref="BoundClrStaticCallExpression"/> nodes referencing real
/// <see cref="System.Reflection.MemberInfo"/> handles (the same shape
/// state-machine synthesis already uses via
/// <see cref="Emit.BclMember"/>), so no user-visible scope/import
/// resolution is needed to construct <c>new Regex(...)</c> or
/// <c>TimeSpan.FromMilliseconds(...)</c>.
/// </remarks>
internal static class GeneratedRegexBinder
{
    private const long RegexOptionsIgnoreCase = (long)RegexOptions.IgnoreCase;
    private const long RegexOptionsCultureInvariant = (long)RegexOptions.CultureInvariant;

    /// <summary>
    /// When <paramref name="function"/> carries an <c>@GeneratedRegex</c>
    /// annotation, validates the shape and attaches
    /// <see cref="FunctionSymbol.GeneratedRegexMetadata"/> plus a
    /// synthesized <see cref="FunctionSymbol.GeneratedRegexBackingField"/>
    /// on success. Reports GS0593–GS0596 on any malformed input.
    /// </summary>
    /// <param name="function">The function symbol being declared. Its <c>SetAttributes</c> call must already have run.</param>
    /// <param name="syntax">The originating function declaration syntax.</param>
    /// <param name="diagnostics">The diagnostics bag for this binder.</param>
    /// <returns>
    /// <c>true</c> when an <c>@GeneratedRegex</c> annotation is present (with
    /// or without errors — mirroring <see cref="PInvokeBinder.TryAttachPInvokeMetadata"/>),
    /// so the caller suppresses the generic "no recognised bodyless-declaration
    /// attribute" fallback; <c>false</c> when no such annotation exists.
    /// </returns>
    internal static bool TryAttachGeneratedRegexMetadata(
        FunctionSymbol function,
        FunctionDeclarationSyntax syntax,
        DiagnosticBag diagnostics)
    {
        var attribute = KnownAttributes.FindGeneratedRegex(function.Attributes);
        if (attribute == null)
        {
            return false;
        }

        var identifierLocation = syntax.Identifier.Location;
        var attributeLocation = attribute.Syntax.Location;

        var shapeIsValid = true;

        if (syntax.Body != null)
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                identifierLocation,
                function.Name,
                "the declaration must not have a body; replace the '{ ... }' block with ';'");
            shapeIsValid = false;
        }

        if (function.Parameters.Length != 0)
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                identifierLocation,
                function.Name,
                "a parameter list is not supported; a generated-regex function takes no parameters");
            shapeIsValid = false;
        }

        if (function.IsGeneric)
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                identifierLocation,
                function.Name,
                "generic functions are not supported");
            shapeIsValid = false;
        }

        if (function.IsAsync)
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                identifierLocation,
                function.Name,
                "async functions are not supported");
            shapeIsValid = false;
        }

        if (function.IsExtension)
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                identifierLocation,
                function.Name,
                "extension functions are not supported");
            shapeIsValid = false;
        }

        if (function.ReturnRefKind != RefKind.None)
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                identifierLocation,
                function.Name,
                "ref-returning functions are not supported");
            shapeIsValid = false;
        }

        if (function.Type?.ClrType?.FullName != "System.Text.RegularExpressions.Regex")
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                identifierLocation,
                function.Name,
                "the return type must be 'System.Text.RegularExpressions.Regex'");
            shapeIsValid = false;
        }

        if (!shapeIsValid)
        {
            // Recognised as an attempted @GeneratedRegex declaration (the
            // caller suppresses the generic no-body / abstract-method
            // fallback), but not wired for emit — GeneratedRegexMetadata
            // stays null. The already-reported shape diagnostics are the
            // only signal; there is no well-formed shape left to extract
            // pattern/options from.
            return true;
        }

        // TryExtractArguments reports its own diagnostic (GS0593 for a
        // missing/non-constant pattern, GS0594 for a malformed `options`
        // argument) before returning false, so there is nothing more to
        // report here.
        if (!TryExtractArguments(attribute, function, diagnostics, out var pattern, out var optionsValue, out var hasTimeout, out var timeoutMilliseconds, out var cultureName))
        {
            return true;
        }

        // Culture-sensitive IgnoreCase restriction: a GeneratedRegex combining
        // IgnoreCase (explicitly, or via an inline "(?i)" option group) without
        // CultureInvariant, or with an explicit non-empty cultureName, cannot be
        // lowered to plain Regex construction without changing comparison
        // semantics (mirrors TryTranslateGeneratedRegex's ReportUnsupported case).
        var usesIgnoreCase = (optionsValue & RegexOptionsIgnoreCase) != 0 || PatternEnablesInlineIgnoreCase(pattern);
        if (usesIgnoreCase && ((optionsValue & RegexOptionsCultureInvariant) == 0 || cultureName.Length > 0))
        {
            diagnostics.ReportGeneratedRegexCultureSensitiveIgnoreCase(attributeLocation, function.Name);
            return true;
        }

        // Compile-time construction probe (issue #4301 review guidance):
        // validates the pattern syntax AND the RegexOptions bit combination
        // AND (when an explicit timeout is given) that it is either -1 or a
        // positive value — exactly what the real 2-/3-arg `Regex` constructor
        // validates, run here so a malformed declaration is reported as a
        // gsc diagnostic instead of throwing a TypeInitializationException
        // out of the emitted type's .cctor at first use.
        try
        {
            _ = hasTimeout
                ? new Regex(pattern, (RegexOptions)optionsValue, TimeSpan.FromMilliseconds(timeoutMilliseconds))
                : new Regex(pattern, (RegexOptions)optionsValue);
        }
        catch (ArgumentException ex)
        {
            diagnostics.ReportGeneratedRegexConstructionFailed(attributeLocation, function.Name, ex.Message);
            return true;
        }

        var metadata = new GeneratedRegexMetadata(pattern, optionsValue, hasTimeout, timeoutMilliseconds, cultureName);
        function.GeneratedRegexMetadata = metadata;

        function.GeneratedRegexBackingField = new FieldSymbol(
            BackingFieldName(function.Name),
            function.Type!,
            Accessibility.Private,
            isReadOnly: false,
            isStatic: true);

        return true;
    }

    /// <summary>
    /// Builds the trivial <c>return &lt;backing field&gt;</c> body for a
    /// well-formed <c>@GeneratedRegex</c> function
    /// (<see cref="FunctionSymbol.IsGeneratedRegex"/>). Called from the body
    /// -binding dispatch (<see cref="Binder"/>) in place of ordinary syntax
    /// -driven body binding, since the source declaration has no body at
    /// all.
    /// </summary>
    /// <param name="function">A function with a non-null <see cref="FunctionSymbol.GeneratedRegexBackingField"/>.</param>
    /// <returns>The synthesized bound body.</returns>
    internal static BoundBlockStatement BuildMethodBody(FunctionSymbol function)
    {
        var backingField = function.GeneratedRegexBackingField
            ?? throw new InvalidOperationException("A well-formed @GeneratedRegex function must have a backing field.");
        var ownerType = function.ContainingType as StructSymbol;
        var anchor = function.Declaration;

        var fieldRead = new BoundFieldAccessExpression(anchor, receiver: null, structType: ownerType, field: backingField);
        var returnStatement = new BoundReturnStatement(anchor, fieldRead);
        return new BoundBlockStatement(anchor, ImmutableArray.Create<BoundStatement>(returnStatement));
    }

    /// <summary>
    /// Builds the <c>new Regex(pattern, options[, matchTimeout])</c>
    /// initializer for <paramref name="function"/>'s backing field, to be
    /// merged into the declaring type's
    /// <see cref="StructSymbol.StaticFieldInitializers"/> so it runs as part
    /// of the ordinary <c>.cctor</c> (eager initialization — matching what
    /// cs2gs's own <c>let</c>-field-with-initializer lowering already ships
    /// and exercises via the Issue3086GeneratedRegex fixture).
    /// </summary>
    /// <param name="function">A well-formed <c>@GeneratedRegex</c> function.</param>
    /// <returns>The initializer expression.</returns>
    internal static BoundExpression BuildBackingFieldInitializer(FunctionSymbol function)
    {
        var metadata = function.GeneratedRegexMetadata
            ?? throw new InvalidOperationException("A well-formed @GeneratedRegex function must have GeneratedRegexMetadata.");
        var anchor = function.Declaration;
        var regexClrType = typeof(Regex);

        var patternArgument = new BoundLiteralExpression(anchor, metadata.Pattern);
        var optionsArgument = new BoundLiteralExpression(anchor, metadata.OptionsValue, TypeSymbol.Int32);

        if (!metadata.HasMatchTimeout)
        {
            var twoArgConstructor = BclMember.Ctor(regexClrType, typeof(string), typeof(RegexOptions));
            return new BoundClrConstructorCallExpression(
                anchor,
                regexClrType,
                twoArgConstructor,
                ImmutableArray.Create<BoundExpression>(patternArgument, optionsArgument),
                function.Type);
        }

        // Issue #4301: -1 is value-equal to Regex.InfiniteMatchTimeout
        // (both are TimeSpan.FromMilliseconds(-1) = -10000 ticks) — a plain
        // TimeSpan VALUE, compared by value everywhere it matters (the
        // fixture's HasDefaultRegexSemantics check included), so no
        // special-cased field reference is needed for that case.
        var fromMillisecondsMethod = BclMember.Method(typeof(TimeSpan), "FromMilliseconds", typeof(double));
        var timeoutArgument = new BoundClrStaticCallExpression(
            anchor,
            fromMillisecondsMethod,
            TypeSymbol.FromClrType(typeof(TimeSpan)),
            ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(anchor, (double)metadata.MatchTimeoutMilliseconds)));

        var threeArgConstructor = BclMember.Ctor(regexClrType, typeof(string), typeof(RegexOptions), typeof(TimeSpan));
        return new BoundClrConstructorCallExpression(
            anchor,
            regexClrType,
            threeArgConstructor,
            ImmutableArray.Create<BoundExpression>(patternArgument, optionsArgument, timeoutArgument),
            function.Type);
    }

    private static string BackingFieldName(string functionName)
    {
        // ADR-0051 auto-property convention: `<Name>k__BackingField`. Never
        // printed in G# source; collision with a user-declared member of the
        // same synthesized name is astronomically unlikely (it would require
        // the user to hand-write the exact CLR-mangled name), so — unlike
        // cs2gs's own `__generatedRegex_` cache-name collision loop, which
        // guards against colliding with an ordinary printable identifier —
        // no collision probe is needed here.
        return $"<{functionName}>k__BackingField";
    }

    private static bool TryExtractArguments(
        BoundAttribute attribute,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        out string pattern,
        out int optionsValue,
        out bool hasTimeout,
        out int timeoutMilliseconds,
        out string cultureName)
    {
        pattern = string.Empty;
        optionsValue = 0;
        hasTimeout = false;
        timeoutMilliseconds = -1;
        cultureName = string.Empty;

        var attributeLocation = attribute.Syntax.Location;
        var positional = attribute.PositionalArguments;
        if (positional.IsDefaultOrEmpty || positional[0].Value is not string patternText || patternText.Length == 0)
        {
            diagnostics.ReportGeneratedRegexMissingPattern(attributeLocation, function.Name);
            return false;
        }

        pattern = patternText;

        // Issue #4301 review: the general attribute-argument binder accepts
        // any compile-time constant here, not just an int/RegexOptions one —
        // `Convert.ToInt32` on a raw boxed value is unsafe for that: it
        // THROWS an uncaught FormatException for a non-numeric string
        // (`@GeneratedRegex(pattern, "bogus")`), and it SILENTLY succeeds
        // with a wrong value for e.g. `bool` (`Convert.ToInt32(true) == 1`,
        // becoming `RegexOptions.IgnoreCase` with no diagnostic at all).
        // `KnownAttributes.TryConvertToInt32` is the same closed-set-of-real-
        // representations conversion `@DllImport`'s enum-valued arguments
        // already use — reuse it instead of a second, unsafe one.
        if (positional.Length > 1 && !KnownAttributes.TryConvertToInt32(positional[1].Value, out optionsValue))
        {
            diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                attributeLocation,
                function.Name,
                "the 'options' argument must be a 'RegexOptions' value");
            return false;
        }

        // The third positional argument is either `matchTimeoutMilliseconds`
        // (int) or `cultureName` (string) — GeneratedRegexAttribute has two
        // distinct 3-arg constructor overloads disambiguated by that
        // parameter's type; gsc's generic attribute binder does not track
        // constructor-parameter identity for positional arguments (only
        // named arguments carry a name), so the runtime type of the boxed
        // value disambiguates instead.
        if (positional.Length > 2)
        {
            switch (positional[2].Value)
            {
                case int timeoutInt:
                    hasTimeout = true;
                    timeoutMilliseconds = timeoutInt;
                    break;
                case string cultureText:
                    cultureName = cultureText;
                    break;
            }
        }

        foreach (var named in attribute.NamedArguments)
        {
            switch (named.Name)
            {
                case "options" when named.Value is { } namedOptions:
                    if (!KnownAttributes.TryConvertToInt32(namedOptions, out optionsValue))
                    {
                        diagnostics.ReportGeneratedRegexInvalidFunctionShape(
                            attributeLocation,
                            function.Name,
                            "the 'options' argument must be a 'RegexOptions' value");
                        return false;
                    }

                    break;
                case "matchTimeoutMilliseconds" when named.Value is int namedTimeout:
                    hasTimeout = true;
                    timeoutMilliseconds = namedTimeout;
                    break;
                case "cultureName" when named.Value is string namedCulture:
                    cultureName = namedCulture;
                    break;
            }
        }

        return true;
    }

    /// <summary>
    /// Ported from <c>TryTranslateGeneratedRegex.PatternEnablesInlineIgnoreCase</c>
    /// (<c>tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Members.cs</c>),
    /// the authoritative reference: scans <paramref name="pattern"/> for an
    /// inline option group (<c>(?i)</c>, <c>(?im)</c>, ...) that enables
    /// <c>RegexOptions.IgnoreCase</c> for at least part of the pattern,
    /// skipping character classes, escapes, and <c>(?#...)</c> comments.
    /// </summary>
    private static bool PatternEnablesInlineIgnoreCase(string pattern)
    {
        var inCharacterClass = false;
        var firstCharacterInClass = false;

        for (var i = 0; i < pattern.Length; i++)
        {
            var current = pattern[i];
            if (current == '\\')
            {
                if (inCharacterClass)
                {
                    firstCharacterInClass = false;
                }

                i++;
                continue;
            }

            if (inCharacterClass)
            {
                if (current == ']' && !firstCharacterInClass)
                {
                    inCharacterClass = false;
                }
                else if (current != '^' || !firstCharacterInClass)
                {
                    firstCharacterInClass = false;
                }

                continue;
            }

            if (current == '[')
            {
                inCharacterClass = true;
                firstCharacterInClass = true;
                continue;
            }

            if (current != '(' || i + 2 >= pattern.Length || pattern[i + 1] != '?')
            {
                continue;
            }

            if (pattern[i + 2] == '#')
            {
                var commentEnd = pattern.IndexOf(')', i + 3);
                if (commentEnd < 0)
                {
                    return false;
                }

                i = commentEnd;
                continue;
            }

            if (InlineOptionsEnableIgnoreCase(pattern, i + 2))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Ported from <c>TryTranslateGeneratedRegex.InlineOptionsEnableIgnoreCase</c> (same source).</summary>
    private static bool InlineOptionsEnableIgnoreCase(string pattern, int start)
    {
        var disabling = false;
        var sawOption = false;
        var sawDisabledOption = false;
        var enabledIgnoreCase = false;
        var disabledIgnoreCase = false;
        var i = start;

        for (; i < pattern.Length; i++)
        {
            var option = pattern[i];
            if (option == '-')
            {
                if (disabling)
                {
                    return false;
                }

                disabling = true;
                continue;
            }

            if (option is not ('i' or 'm' or 'n' or 's' or 'x'))
            {
                break;
            }

            sawOption = true;
            if (disabling)
            {
                sawDisabledOption = true;
                disabledIgnoreCase |= option == 'i';
            }
            else
            {
                enabledIgnoreCase |= option == 'i';
            }
        }

        return sawOption &&
            (!disabling || sawDisabledOption) &&
            i < pattern.Length &&
            pattern[i] is ')' or ':' &&
            enabledIgnoreCase &&
            !disabledIgnoreCase;
    }
}
