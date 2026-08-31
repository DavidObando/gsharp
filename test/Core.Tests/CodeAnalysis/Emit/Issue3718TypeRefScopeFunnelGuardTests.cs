// <copyright file="Issue3718TypeRefScopeFunnelGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3718, the TypeRef-resolution-scope funnel's guard rail — the sibling
/// of <c>Issue3705LoadContextFunnelGuardTests</c>. That one forbids
/// <em>comparing</em> against a live host <c>typeof</c>; this one keeps the
/// compiler from <em>emitting</em> one.
/// <para>
/// A compiler-internal <c>typeof(X)</c> yields a runtime <see cref="Type"/>
/// whose assembly is whichever corlib hosts gsc. Turning that type into a
/// <c>TypeRef</c> row scoped to <c>type.Assembly</c> writes an
/// <c>AssemblyRef</c> to <c>System.Private.CoreLib</c> into an assembly whose
/// reference closure only ever named the targeting pack — 65 of the 128
/// conformance samples did exactly that before #3718. The defect is invisible
/// to an IL comparison (the opcode stream is unchanged) and to the build (the
/// row is well-formed), so the only durable protection is structural: exactly
/// one place in the compiler may write a <c>TypeRef</c> or an
/// <c>AssemblyRef</c>, and that place projects the type onto the compilation's
/// reference closure first.
/// </para>
/// </summary>
public class Issue3718TypeRefScopeFunnelGuardTests
{
    /// <summary>
    /// The sole sanctioned producer of <c>TypeRef</c> / <c>AssemblyRef</c>
    /// rows: <c>ImportedMemberRefFactory.GetTypeReference(Type)</c> projects a
    /// host type onto <c>EmitContext.References</c> before choosing the row's
    /// resolution scope, and <c>GetAssemblyReference</c> is reached only from
    /// there. A second producer would bypass the projection.
    /// </summary>
    private static readonly Dictionary<string, string> AllowedFiles = new(StringComparer.Ordinal)
    {
        ["src/Core/CodeAnalysis/Emit/ImportedMemberRefFactory.cs"] =
            "#3718 — the funnel itself: projects host types onto the reference closure before scoping the row",
    };

    private static readonly string[] ScannedRoots = new[]
    {
        "src/Core/CodeAnalysis/Binding",
        "src/Core/CodeAnalysis/Lowering",
        "src/Core/CodeAnalysis/Emit",
        "src/Core/CodeAnalysis/Symbols",
    };

    private static readonly Regex ForbiddenPattern = new(
        @"\.\s*Add(Type|Assembly)Reference\s*\(",
        RegexOptions.Compiled);

    /// <summary>
    /// Fails when a <c>TypeRef</c> or <c>AssemblyRef</c> row is written
    /// anywhere but the funnel.
    /// </summary>
    [Fact]
    public void No_TypeRef_Or_AssemblyRef_Rows_Outside_The_Funnel()
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
            "A TypeRef / AssemblyRef row is written outside ImportedMemberRefFactory (issue #3718).\n"
                + "Rows created elsewhere skip the projection of host `typeof` types onto the\n"
                + "compilation's reference closure, which leaks a System.Private.CoreLib AssemblyRef\n"
                + "into ref-pack builds. Route through ImportedMemberRefFactory.GetTypeReference, or\n"
                + "add the file to AllowedFiles with a reason:\n  "
                + string.Join("\n  ", offenders));
    }

    /// <summary>
    /// The funnel must keep doing the projection: a rewrite that drops the
    /// call turns this whole guard into a no-op that still passes.
    /// </summary>
    [Fact]
    public void The_Funnel_Still_Projects_Onto_The_Reference_Closure()
    {
        var repoRoot = LocateRepoRoot();
        var funnel = Path.Combine(repoRoot, "src/Core/CodeAnalysis/Emit/ImportedMemberRefFactory.cs");
        Assert.True(File.Exists(funnel), $"the funnel moved: {funnel} does not exist");

        var text = File.ReadAllText(funnel);
        Assert.Contains("TryProjectOntoReferences", text, StringComparison.Ordinal);
        Assert.Contains("TryResolveType", text, StringComparison.Ordinal);
    }

    /// <summary>
    /// Removes line comments and string literals so the pattern only matches
    /// code position — doc comments naming the forbidden idiom (there are
    /// several) must not trip it.
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
