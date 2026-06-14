// <copyright file="Issue835TypeofIdentityRegressionGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #835 regression guard. Scans every compiler / language-server source
/// file for the forbidden reference-identity pattern
/// <c>clrType == typeof(X)</c> / <c>clrType != typeof(X)</c>. Any such usage
/// silently regresses on the BuildTask path, where compiler-consumed
/// <see cref="System.Type"/> instances are loaded through a
/// <see cref="System.Reflection.MetadataLoadContext"/> and therefore are
/// <em>never</em> reference-equal to the host process's <c>typeof()</c>
/// literals. New occurrences must use
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.ClrTypeUtilities.IsSameAs(System.Type, System.Type)"/>
/// (or another structural / FullName-based check) instead.
/// </summary>
/// <remarks>
/// <para>
/// The guard intentionally errs on the side of being noisy: it flags *every*
/// surviving <c>== typeof(</c> / <c>!= typeof(</c> in source-position code,
/// even ones that today are reachable only from the gsc interpreter and would
/// never see an MLC type. Migrating those keeps the codebase consistent and
/// removes the trap for future contributors who reuse an existing helper from
/// the BuildTask path.
/// </para>
/// <para>
/// Doc-comment / string-literal occurrences are ignored. If a genuinely
/// legitimate reference-identity comparison is added in the future, it must
/// be appended to <see cref="ExpectedAllowedSites"/> with an inline
/// justification.
/// </para>
/// </remarks>
public class Issue835TypeofIdentityRegressionGuardTests
{
    /// <summary>
    /// Allow-list of <c>(relative path, lineNumber, justification)</c> tuples
    /// for legitimate reference-identity comparisons. Empty after issue #835
    /// — every prior occurrence migrated to <c>IsSameAs</c>.
    /// </summary>
    private static readonly (string RelativePath, int Line)[] ExpectedAllowedSites = Array.Empty<(string, int)>();

    private static readonly string[] ScannedRoots = new[]
    {
        "src/Core",
        "src/Compiler",
        "src/LanguageServer",
        "src/Sdk",
    };

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
    private static readonly Regex ForbiddenPattern = new(
        @"(==|!=)\s*typeof\s*\([^)]*\)\s*(?![.\w])|typeof\s*\([^)]*\)(?!\s*\.(?:FullName|Name|AssemblyQualifiedName|Namespace|IsGenericTypeDefinition|GetTypeInfo))\s*(==|!=)",
        RegexOptions.Compiled);

    [Fact]
    public void No_ReferenceIdentity_TypeofComparisons_In_Compiler_Sources()
    {
        var repoRoot = LocateRepoRoot();
        var offenders = new List<(string RelativePath, int Line, string Code)>();

        foreach (var root in ScannedRoots)
        {
            var rootDir = Path.Combine(repoRoot, root);
            if (!Directory.Exists(rootDir))
            {
                continue;
            }

            foreach (var file in Directory.EnumerateFiles(rootDir, "*.cs", SearchOption.AllDirectories))
            {
                if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    || file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
                {
                    continue;
                }

                var relative = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
                var lines = File.ReadAllLines(file);
                for (var i = 0; i < lines.Length; i++)
                {
                    var stripped = StripCommentsAndStrings(lines[i]);
                    if (ForbiddenPattern.IsMatch(stripped))
                    {
                        offenders.Add((relative, i + 1, lines[i].Trim()));
                    }
                }
            }
        }

        // Apply allow-list.
        var allowed = ExpectedAllowedSites.ToHashSet();
        var actualOffenders = offenders
            .Where(o => !allowed.Contains((o.RelativePath, o.Line)))
            .ToList();

        // Detect a stale allow-list entry: an entry that no longer matches
        // anything. Stale entries silently weaken the guard.
        var realLocations = offenders.Select(o => (o.RelativePath, o.Line)).ToHashSet();
        var stale = allowed.Where(a => !realLocations.Contains(a)).ToList();

        if (actualOffenders.Count > 0)
        {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"Issue #835 regression: found {actualOffenders.Count} reference-identity typeof comparison(s) in compiler source.");
            sb.AppendLine("Each silently regresses functionality on the BuildTask (MetadataLoadContext) path.");
            sb.AppendLine("Replace with `clrType.IsSameAs(typeof(X))` (ClrTypeUtilities) or another FullName-based check.");
            sb.AppendLine();
            foreach (var o in actualOffenders)
            {
                sb.AppendLine($"  {o.RelativePath}:{o.Line}  {o.Code}");
            }

            Assert.Fail(sb.ToString());
        }

        if (stale.Count > 0)
        {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine("Stale entries in ExpectedAllowedSites — these no longer match any source line:");
            foreach (var s in stale)
            {
                sb.AppendLine($"  {s.RelativePath}:{s.Line}");
            }

            Assert.Fail(sb.ToString());
        }
    }

    [Fact]
    public void Helper_StripCommentsAndStrings_Strips_LineComments()
    {
        Assert.Equal("x = 1 ", StripCommentsAndStrings("x = 1 // x == typeof(int)"));
        Assert.Equal("x = 1 ", StripCommentsAndStrings("x = 1 /// x == typeof(int)"));
    }

    [Fact]
    public void Helper_StripCommentsAndStrings_Strips_StringLiterals()
    {
        Assert.Equal("var s =  + foo", StripCommentsAndStrings("var s = \"x == typeof(int)\" + foo"));
        Assert.Equal("var s =  + foo", StripCommentsAndStrings("var s = @\"x == typeof(int)\" + foo"));
    }

    [Fact]
    public void Helper_ForbiddenPattern_Matches_RawIdentity()
    {
        Assert.Matches(ForbiddenPattern, "if (clrType == typeof(int))");
        Assert.Matches(ForbiddenPattern, "return clrType != typeof(int);");
        Assert.Matches(ForbiddenPattern, "typeof(int) == clrType");
        Assert.Matches(ForbiddenPattern, "typeof(int) != clrType");
        Assert.DoesNotMatch(ForbiddenPattern, "if (clrType.IsSameAs(typeof(int)))");
        Assert.DoesNotMatch(ForbiddenPattern, "var t = typeof(int);");

        // Safe string-projection comparisons must NOT trip the guard.
        Assert.DoesNotMatch(ForbiddenPattern, "if (clrType?.FullName == typeof(int).FullName)");
        Assert.DoesNotMatch(ForbiddenPattern, "if (clrType?.FullName != typeof(int).FullName)");
        Assert.DoesNotMatch(ForbiddenPattern, "if (typeof(int).FullName == clrType?.FullName)");
        Assert.DoesNotMatch(ForbiddenPattern, "if (typeof(int).Name == clrType?.Name)");
    }

    /// <summary>
    /// Strips C# line comments (<c>//</c> and <c>///</c>) and removes the
    /// contents of string / verbatim-string / interpolated-string literals.
    /// Block comments (<c>/* ... */</c>) are not stripped — the guard does not
    /// see them often and conservatively letting them through risks at most
    /// false positives, which are easy to fix.
    /// </summary>
    private static string StripCommentsAndStrings(string line)
    {
        var sb = new System.Text.StringBuilder(line.Length);
        var i = 0;
        while (i < line.Length)
        {
            // Line comment swallows the rest.
            if (i + 1 < line.Length && line[i] == '/' && line[i + 1] == '/')
            {
                break;
            }

            // Verbatim or interpolated-verbatim string literal: @"..." or $@"..." / @$"...".
            var isVerbatim = i < line.Length && line[i] == '@'
                ? (i + 1 < line.Length && line[i + 1] == '"')
                : (i + 1 < line.Length && line[i] == '$' && line[i + 1] == '@' && i + 2 < line.Length && line[i + 2] == '"');
            if (isVerbatim)
            {
                // Advance past the prefix to the opening quote.
                while (i < line.Length && line[i] != '"')
                {
                    i++;
                }

                i++; // skip opening "
                while (i < line.Length)
                {
                    if (line[i] == '"' && i + 1 < line.Length && line[i + 1] == '"')
                    {
                        i += 2; // escaped quote in verbatim string
                        continue;
                    }

                    if (line[i] == '"')
                    {
                        i++; // closing "
                        break;
                    }

                    i++;
                }

                continue;
            }

            // Regular string literal: "..." (with \" escapes). Also handles
            // interpolated $"..." identically — we don't need to evaluate the
            // interpolated expressions, just skip the literal range.
            var isRegularString = line[i] == '"'
                || (i + 1 < line.Length && line[i] == '$' && line[i + 1] == '"');
            if (isRegularString)
            {
                while (i < line.Length && line[i] != '"')
                {
                    i++;
                }

                i++; // skip opening "
                while (i < line.Length)
                {
                    if (line[i] == '\\' && i + 1 < line.Length)
                    {
                        i += 2;
                        continue;
                    }

                    if (line[i] == '"')
                    {
                        i++; // closing "
                        break;
                    }

                    i++;
                }

                continue;
            }

            // Character literal: '...'
            if (line[i] == '\'')
            {
                i++;
                while (i < line.Length)
                {
                    if (line[i] == '\\' && i + 1 < line.Length)
                    {
                        i += 2;
                        continue;
                    }

                    if (line[i] == '\'')
                    {
                        i++;
                        break;
                    }

                    i++;
                }

                continue;
            }

            sb.Append(line[i]);
            i++;
        }

        return sb.ToString();
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return dir.FullName;
    }
}
