// <copyright file="Issue835TypeofIdentityRegressionGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #835 regression guard. Scans every compiler / language-server source
/// file for the forbidden reference-identity pattern
/// `clrType == typeof(X)` / `clrType != typeof(X)`. Any such usage
/// silently regresses on the BuildTask path, where compiler-consumed
/// (cref:System.Type) instances are loaded through a
/// (cref:System.Reflection.MetadataLoadContext) and therefore are
/// <em>never</em> reference-equal to the host process's `typeof()`
/// literals. New occurrences must use
/// (cref:GSharp.Core.CodeAnalysis.Symbols.ClrTypeUtilities.IsSameAs(System.Type, System.Type))
/// (or another structural / FullName-based check) instead.
/// @remarks The guard intentionally errs on the side of being noisy: it flags *every*
/// surviving `== typeof(` / `!= typeof(` in source-position code,
/// even ones that today are not reached through the BuildTask path and would
/// never see an MLC type. Migrating those keeps the codebase consistent and
/// removes the trap for future contributors who reuse an existing helper from
/// the BuildTask path.
///
/// Doc-comment / string-literal occurrences are ignored. If a genuinely
/// legitimate reference-identity comparison is added in the future, it must
/// be appended to (cref:ExpectedAllowedSites) with an inline
/// justification.
open class Issue835TypeofIdentityRegressionGuardTests {
    @Fact
    func No_ReferenceIdentity_TypeofComparisons_In_Compiler_Sources() {
        let offenders = List[(RelativePath string, Line int32, Code string)]()
        // Issue #4656: the tree's own language (C# before the cut-over, G#
        // after; relative paths carry no extension), and a scan that finds
        // nothing fails instead of passing.
        for file in TestSource.SourceFiles(SearchOption.AllDirectories, ScannedRoots) {
            let relative = TestSource.RelativeStem(file)
            let lines = File.ReadAllLines(file)
            for var i = 0; i < lines.Length; i++ {
                let stripped = StripCommentsAndStrings(lines[i])
                if ForbiddenPattern.IsMatch(stripped) {
                    offenders.Add((relative, i + 1, lines[i].Trim()))
                }
            }
        }
        // Apply allow-list.
        let allowed = ExpectedAllowedSites.ToHashSet()
        let actualOffenders = offenders.Where(
            (o(RelativePath string, Line int32, Code string)) -> !allowed.Contains((o.RelativePath, o.Line))
        )
            .ToList()
        // Detect a stale allow-list entry: an entry that no longer matches
        // anything. Stale entries silently weaken the guard.
        let realLocations = offenders.Select(
            (o(RelativePath string, Line int32, Code string)) -> (o.RelativePath, o.Line)
        )
            .ToHashSet()
        let stale = allowed.Where((a(RelativePath string, Line int32)) -> !realLocations.Contains(a)).ToList()
        if actualOffenders.Count > 0 {
            let sb = StringBuilder()
            sb.AppendLine(
                "Issue #835 regression: found ${actualOffenders.Count} reference-identity typeof comparison(s) in compiler source."
            )
            sb.AppendLine("Each silently regresses functionality on the BuildTask (MetadataLoadContext) path.")
            sb.AppendLine(
                "Replace with `clrType.IsSameAs(typeof(X))` (ClrTypeUtilities) or another FullName-based check."
            )
            sb.AppendLine()
            for o in actualOffenders {
                sb.AppendLine("  ${o.RelativePath}:${o.Line}  ${o.Code}")
            }
            Assert.Fail(sb.ToString())
        }
        if stale.Count > 0 {
            let sb = StringBuilder()
            sb.AppendLine("Stale entries in ExpectedAllowedSites — these no longer match any source line:")
            for s in stale {
                sb.AppendLine("  ${s.RelativePath}:${s.Line}")
            }
            Assert.Fail(sb.ToString())
        }
    }

    @Fact
    func Helper_StripCommentsAndStrings_Strips_LineComments() {
        Assert.Equal("x = 1 ", StripCommentsAndStrings("x = 1 // x == typeof(int)"))
        Assert.Equal("x = 1 ", StripCommentsAndStrings("x = 1 /// x == typeof(int)"))
    }

    @Fact
    func Helper_StripCommentsAndStrings_Strips_StringLiterals() {
        Assert.Equal("var s =  + foo", StripCommentsAndStrings("var s = \"x == typeof(int)\" + foo"))
        Assert.Equal("var s =  + foo", StripCommentsAndStrings("var s = @\"x == typeof(int)\" + foo"))
    }

    @Fact
    func Helper_ForbiddenPattern_Matches_RawIdentity() {
        Assert.Matches(ForbiddenPattern, "if (clrType == typeof(int))")
        Assert.Matches(ForbiddenPattern, "return clrType != typeof(int);")
        Assert.Matches(ForbiddenPattern, "typeof(int) == clrType")
        Assert.Matches(ForbiddenPattern, "typeof(int) != clrType")
        Assert.DoesNotMatch(ForbiddenPattern, "if (clrType.IsSameAs(typeof(int)))")
        Assert.DoesNotMatch(ForbiddenPattern, "var t = typeof(int);")
        // Safe string-projection comparisons must NOT trip the guard.
        Assert.DoesNotMatch(ForbiddenPattern, "if (clrType?.FullName == typeof(int).FullName)")
        Assert.DoesNotMatch(ForbiddenPattern, "if (clrType?.FullName != typeof(int).FullName)")
        Assert.DoesNotMatch(ForbiddenPattern, "if (typeof(int).FullName == clrType?.FullName)")
        Assert.DoesNotMatch(ForbiddenPattern, "if (typeof(int).Name == clrType?.Name)")
    }

    shared {
        /// Allow-list of `(relative path, lineNumber, justification)` tuples
        /// for legitimate reference-identity comparisons. Empty after issue #835
        /// — every prior occurrence migrated to `IsSameAs`.
        private let ExpectedAllowedSites[](RelativePath string, Line int32) = Array.Empty[(string, int32)]()

        private let ScannedRoots[]string = []string{"src/Core", "src/Compiler", "src/LanguageServer", "src/Sdk"}

        // Matches forbidden reference-identity comparisons against typeof(...) in
        // *code* position. The pattern is intentionally tight: it requires whitespace
        // immediately before == / != to avoid matching inside identifiers (e.g.
        // an imaginary `foo==typeof` would still trip, since `==` is always
        // surrounded by either whitespace or operators), and it does not match the
        // textual sequence inside a `// ...` line comment, `/// ...` doc comment,
        // or a string / verbatim / interpolated literal — those are stripped by
        // <see cref="StripCommentsAndStrings"/> below before the regex runs.
        //
        // A `typeof(X).FullName` / `.Name` / `.AssemblyQualifiedName` projection
        // followed by `==` / `!=` is a safe string-comparison idiom and is NOT
        // flagged (negative lookahead in the right-hand branch).
        private let ForbiddenPattern Regex = Regex(
            "(==|!=)\\s*typeof\\s*\\([^)]*\\)\\s*(?![.\\w])|typeof\\s*\\([^)]*\\)(?!\\s*\\.(?:FullName|Name|AssemblyQualifiedName|Namespace|IsGenericTypeDefinition|GetTypeInfo))\\s*(==|!=)",
            RegexOptions.Compiled
        )

        /// Strips C# line comments (`//` and `///`) and removes the
        /// contents of string / verbatim-string / interpolated-string literals.
        /// Block comments (`/* ... */`) are not stripped — the guard does not
        /// see them often and conservatively letting them through risks at most
        /// false positives, which are easy to fix.
        private func StripCommentsAndStrings(line string) string {
            let sb = StringBuilder(line.Length)
            var i = 0
            while i < line.Length {
                // Line comment swallows the rest.
                if i + 1 < line.Length && line[i] == '/' && line[i + 1] == '/' {
                    break
                }
                // Verbatim or interpolated-verbatim string literal: @"..." or $@"..." / @$"...".
                let isVerbatim = if i < line.Length && line[i] == '@' {
                    (i + 1 < line.Length && line[i + 1] == '"')
                } else {
                    (
                        i +
                            1 < line.Length &&
                            line[i] == '$' &&
                            line[i + 1] == '@' &&
                            i +
                            2 < line.Length &&
                            line[i + 2] == '"'
                    )
                }
                if isVerbatim {
                    // Advance past the prefix to the opening quote.
                    while i < line.Length && line[i] != '"' {
                        i++
                    }
                    i++ // skip opening "
                    while i < line.Length {
                        if line[i] == '"' && i + 1 < line.Length && line[i + 1] == '"' {
                            i += 2 // escaped quote in verbatim string
                            continue
                        }
                        if line[i] == '"' {
                            i++ // closing "
                            break
                        }
                        i++
                    }
                    continue
                }
                // Regular string literal: "..." (with \" escapes). Also handles
                // interpolated $"..." identically — we don't need to evaluate the
                // interpolated expressions, just skip the literal range.
                let isRegularString = line[i] == '"' || (i + 1 < line.Length && line[i] == '$' && line[i + 1] == '"')
                if isRegularString {
                    while i < line.Length && line[i] != '"' {
                        i++
                    }
                    i++ // skip opening "
                    while i < line.Length {
                        if line[i] == '\\' && i + 1 < line.Length {
                            i += 2
                            continue
                        }
                        if line[i] == '"' {
                            i++ // closing "
                            break
                        }
                        i++
                    }
                    continue
                }
                // Character literal: '...'
                if line[i] == '\'' {
                    i++
                    while i < line.Length {
                        if line[i] == '\\' && i + 1 < line.Length {
                            i += 2
                            continue
                        }
                        if line[i] == '\'' {
                            i++
                            break
                        }
                        i++
                    }
                    continue
                }
                sb.Append(line[i])
                i++
            }
            return sb.ToString()
        }
    }
}
