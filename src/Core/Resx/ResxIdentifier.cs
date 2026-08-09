// <copyright file="ResxIdentifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.Resx;

/// <summary>
/// Turns a resx resource key into a valid G# member identifier (ADR-0142),
/// mirroring the naming rules the real <c>ResXFileCodeGenerator</c> /
/// <c>StronglyTypedResourceBuilder</c> applies to C# identifiers: any
/// character that is not a letter, digit, or underscore is replaced with
/// <c>_</c>, a leading digit is prefixed with <c>_</c>, and a name that
/// collides with a G# reserved keyword — or with a name already emitted by
/// this generator (including the fixed <c>ResourceManager</c>/<c>Culture</c>
/// accessors) — gets a numeric suffix. G# has no verbatim-identifier escape
/// (no C#-style <c>@keyword</c>), so the suffix is the only collision
/// remedy available.
/// </summary>
public static class ResxIdentifier
{
    /// <summary>
    /// Converts a resx key to a valid, non-colliding G# identifier.
    /// </summary>
    /// <param name="resourceKey">The raw resx <c>name</c> attribute.</param>
    /// <param name="usedNames">
    /// The set of identifiers already emitted in the current class (seeded
    /// with the fixed <c>ResourceManager</c>/<c>Culture</c> property names);
    /// the chosen identifier is added to this set before returning.
    /// </param>
    /// <returns>A valid G# identifier, unique within <paramref name="usedNames"/>.</returns>
    public static string ToPropertyIdentifier(string resourceKey, HashSet<string> usedNames)
    {
        string sanitized = Sanitize(resourceKey);
        string candidate = sanitized;
        int suffix = 1;
        while (usedNames.Contains(candidate) || IsReservedKeyword(candidate))
        {
            candidate = sanitized + suffix;
            suffix++;
        }

        usedNames.Add(candidate);
        return candidate;
    }

    private static string Sanitize(string resourceKey)
    {
        if (string.IsNullOrEmpty(resourceKey))
        {
            return "_";
        }

        var builder = new StringBuilder(resourceKey.Length);
        foreach (char c in resourceKey)
        {
            builder.Append(char.IsLetterOrDigit(c) || c == '_' ? c : '_');
        }

        if (builder.Length == 0 || char.IsDigit(builder[0]))
        {
            builder.Insert(0, '_');
        }

        return builder.ToString();
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="candidate"/> is one of
    /// G#'s reserved keywords (via <see cref="SyntaxFacts.GetKeywordKind"/>) —
    /// a resx key sanitizing to a keyword needs its numeric suffix even
    /// though it did not collide with another resource or the fixed
    /// accessor names.
    /// </summary>
    private static bool IsReservedKeyword(string candidate)
    {
        return SyntaxFacts.GetKeywordKind(candidate) != SyntaxKind.IdentifierToken;
    }
}
