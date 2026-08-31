// <copyright file="Issue3705LoadContextFunnelGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #3705 (family 3), the load-context funnel's guard rail — the
/// companion to <c>Issue835TypeofIdentityRegressionGuardTests</c>, which
/// forbids <c>clrType == typeof(X)</c> for the same reason.
/// <para>
/// A host <c>typeof(X).IsAssignableFrom(candidate)</c> in the binder, lowerer
/// or emitter is unconditionally <see langword="false"/> whenever
/// <paramref name="candidate"/> came from the compilation's
/// <see cref="System.Reflection.MetadataLoadContext"/> — that is, on every
/// production <c>/reference:</c> compile. It never throws and never
/// diagnoses, so the wrong arm is simply taken: #3708 emitted no
/// <c>Dispose</c> for a <c>for</c> loop over an imported enumerable, and the
/// <c>typeof(Delegate)</c> arm of #3697 dropped every imported event-handler
/// candidate. New sites must ask
/// <c>GSharp.Core.CodeAnalysis.Symbols.ClrLoadContext.Satisfies</c> (well-known
/// target shape) or <c>ClrLoadContext.IsAssignable</c> (two arbitrary types).
/// </para>
/// </summary>
public class Issue3705LoadContextFunnelGuardTests
{
    /// <summary>
    /// Sites that legitimately compare against a well-known host type, with
    /// the reason. Kept as a set rather than an ordered, line-numbered list
    /// (which is what #835's guard uses) because these directories are edited
    /// concurrently; the assertion below only ever fails on an <em>unlisted</em>
    /// offender, so a stale entry cannot break an unrelated PR.
    /// </summary>
    private static readonly Dictionary<string, string> AllowedFiles = new(StringComparer.Ordinal)
    {
        // #3708, fixed separately: the disposal predicate in
        // TryBuildEnumeratorDisposeCall. Listed so this guard can land
        // alongside that fix rather than racing it.
        ["src/Core/CodeAnalysis/Lowering/Lowerer.cs"] = "#3708 — enumerator disposal predicate, fixed under its own issue",
    };

    private static readonly string[] ScannedRoots = new[]
    {
        "src/Core/CodeAnalysis/Binding",
        "src/Core/CodeAnalysis/Lowering",
        "src/Core/CodeAnalysis/Emit",
        "src/Core/CodeAnalysis/Symbols",
    };

    // `typeof(...).IsAssignableFrom(...)`. The inner group forbids nested
    // parentheses so a `typeof(Foo<Bar>)` still matches (angle brackets are
    // not parentheses) while a method call is not mistaken for a typeof.
    private static readonly Regex ForbiddenPattern = new(
        @"typeof\s*\([^()]*\)\s*\.\s*IsAssignableFrom\s*\(",
        RegexOptions.Compiled);

    /// <summary>
    /// Fails when a load-context-crossing assignability probe is hand-rolled
    /// instead of routed through the funnel.
    /// </summary>
    [Fact]
    public void No_Host_TypeofIsAssignableFrom_In_Binding_Lowering_Emit_Or_Symbols()
    {
        var repoRoot = LocateRepoRoot();
        var offenders = new List<string>();

        foreach (var root in ScannedRoots)
        {
            var rootDir = Path.Combine(repoRoot, root);
            if (!Directory.Exists(rootDir))
            {
                continue;
            }

            foreach (var file in Directory.EnumerateFiles(rootDir, "*.cs", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
                if (AllowedFiles.ContainsKey(relative))
                {
                    continue;
                }

                var lines = File.ReadAllLines(file);
                for (var i = 0; i < lines.Length; i++)
                {
                    var code = StripCommentAndStrings(lines[i]);
                    if (ForbiddenPattern.IsMatch(code))
                    {
                        offenders.Add($"{relative}:{i + 1}: {lines[i].Trim()}");
                    }
                }
            }
        }

        Assert.True(
            offenders.Count == 0,
            "Hand-rolled host `typeof(X).IsAssignableFrom(y)` is unconditionally false for a\n"
                + "MetadataLoadContext `y` (issue #3705, family 3). Use ClrLoadContext.Satisfies /\n"
                + "ClrLoadContext.IsAssignable, or add the file to AllowedFiles with a reason:\n  "
                + string.Join("\n  ", offenders));
    }

    /// <summary>
    /// Removes line comments and string literals so the pattern only matches
    /// code position — doc comments describing the forbidden idiom (there are
    /// several, including on <c>ClrLoadContext</c> itself) must not trip it.
    /// </summary>
    /// <param name="line">The source line.</param>
    /// <returns>The line with comment / literal text blanked out.</returns>
    private static string StripCommentAndStrings(string line)
    {
        var trimmed = line.TrimStart();
        if (trimmed.StartsWith("//", StringComparison.Ordinal)
            || trimmed.StartsWith("*", StringComparison.Ordinal))
        {
            return string.Empty;
        }

        var commentIndex = line.IndexOf("//", StringComparison.Ordinal);
        var code = commentIndex >= 0 ? line.Substring(0, commentIndex) : line;
        return Regex.Replace(code, "\"[^\"]*\"", "\"\"");
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
        {
            dir = dir.Parent;
        }

        Assert.True(dir != null, "could not locate the repository root (GSharp.sln)");
        return dir!.FullName;
    }
}
