// <copyright file="ResxIdentifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Resx

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Text

/// Turns a resx resource key into a valid G# member identifier (ADR-0142),
/// mirroring the naming rules the real `ResXFileCodeGenerator` /
/// `StronglyTypedResourceBuilder` applies to C# identifiers: any
/// character that is not a letter, digit, or underscore is replaced with
/// `_`, a leading digit is prefixed with `_`, and a name that
/// collides with a G# reserved keyword — or with a name already emitted by
/// this generator (including the fixed `ResourceManager`/`Culture`
/// accessors) — gets a numeric suffix. G# has no verbatim-identifier escape
/// (no C#-style `@keyword`), so the suffix is the only collision
/// remedy available.
shared class ResxIdentifier {
    /// Converts a resx key to a valid, non-colliding G# identifier.
    /// @param resourceKey The raw resx `name` attribute.
    /// @param usedNames The set of identifiers already emitted in the current class (seeded
    /// with the fixed `ResourceManager`/`Culture` property names);
    /// the chosen identifier is added to this set before returning.
    /// @returns A valid G# identifier, unique within [`usedNames`](paramref).
    func ToPropertyIdentifier(resourceKey string, usedNames HashSet[string]) string {
        let sanitized = Sanitize(resourceKey)
        var candidate = sanitized
        var suffix = 1
        while usedNames.Contains(candidate) || IsReservedKeyword(candidate) {
            candidate = sanitized + suffix.ToString()
            suffix++
        }
        usedNames.Add(candidate)
        return candidate
    }

    private func Sanitize(resourceKey string) string {
        if string.IsNullOrEmpty(resourceKey) {
            return "_"
        }
        let builder = StringBuilder(resourceKey.Length)
        for c in resourceKey {
            builder.Append(
                if char.IsLetterOrDigit(c) || c == '_' {
                    c
                } else {
                    '_'
                }
            )
        }
        if builder.Length == 0 || char.IsDigit(builder[0]) {
            builder.Insert(0, '_')
        }
        return builder.ToString()
    }

    /// Gets a value indicating whether [`candidate`](paramref) is one of
    /// G#'s reserved keywords (via (cref:SyntaxFacts.GetKeywordKind)) —
    /// a resx key sanitizing to a keyword needs its numeric suffix even
    /// though it did not collide with another resource or the fixed
    /// accessor names.
    private func IsReservedKeyword(candidate string) bool {
        return SyntaxFacts.GetKeywordKind(candidate) != SyntaxKind.IdentifierToken
    }
}
