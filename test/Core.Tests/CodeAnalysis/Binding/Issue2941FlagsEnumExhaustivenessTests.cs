// <copyright file="Issue2941FlagsEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2941: flags annotations do not change enum exhaustiveness, and
/// switch-expression diagnostics remain mutually exclusive.
/// </summary>
public class Issue2941FlagsEnumExhaustivenessTests
{
    private const string ExhaustivenessRule = "Enum switches cover named constants only.";
    private const string FlagsRule = "`[Flags]` does not add unnamed bit combinations as required switch arms.";
    private const string OriginRule = "This rule is identical for imported CLR enums and source-declared enums.";

    /// <summary>Gets every enum-origin, switch-form, and coverage-shape combination.</summary>
    public static IEnumerable<object[]> MatrixCases()
    {
        foreach (var origin in Enum.GetValues<EnumOrigin>())
        {
            foreach (var form in Enum.GetValues<SwitchForm>())
            {
                foreach (var shape in Enum.GetValues<SwitchShape>())
                {
                    yield return new object[] { origin, form, shape };
                }
            }
        }
    }

    [Theory]
    [MemberData(nameof(MatrixCases))]
    public void EnumExhaustivenessMatrix_ReportsExactDiagnosticsAndReturnFlow(
        EnumOrigin origin,
        SwitchForm form,
        SwitchShape shape)
    {
        var source = BuildSource(origin, form, shape);
        var tree = SyntaxTree.Parse(SourceText.From(source, $"{origin}-{form}-{shape}.gs"));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        var diagnostics = result.Diagnostics
            .OrderBy(diagnostic => diagnostic.Location.Span.Start)
            .ThenBy(diagnostic => diagnostic.Id, StringComparer.Ordinal)
            .ToArray();
        var expected = ExpectedDiagnostics(form, shape);

        Assert.Equal(expected.Length, diagnostics.Length);
        for (var i = 0; i < expected.Length; i++)
        {
            Assert.Equal(expected[i].Id, diagnostics[i].Id);
            Assert.Equal(
                expected[i].LocationText,
                diagnostics[i].Location.Text.ToString(diagnostics[i].Location.Span));
        }

        Assert.Equal(shape != SwitchShape.Incomplete, result.Success);
        Assert.Equal(shape != SwitchShape.Incomplete, peStream.Length > 0);
        if (form == SwitchForm.Statement)
        {
            Assert.Equal(
                shape == SwitchShape.Incomplete ? 1 : 0,
                diagnostics.Count(diagnostic => diagnostic.Id == "GS0100"));
        }
        else
        {
            Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0100");
        }
    }

    [Fact]
    public void IncompleteEnumSwitchExpression_ReportsOneDiagnosticAtSwitch()
    {
        var source = BuildSource(EnumOrigin.ImportedFlags, SwitchForm.Expression, SwitchShape.Incomplete);
        var tree = SyntaxTree.Parse(SourceText.From(source, "single-diagnostic.gs"));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0177", diagnostic.Id);
        Assert.Equal("switch", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void LiveDiagnosticDocs_StateNamedConstantFlagsRule()
    {
        var repoRoot = FindRepoRoot();
        foreach (var relativePath in new[] { "docs/diagnostics.md", "website/docs/ref/diagnostics.md" })
        {
            var text = File.ReadAllText(Path.Combine(repoRoot, relativePath));
            Assert.Contains(ExhaustivenessRule, text, StringComparison.Ordinal);
            Assert.Contains(FlagsRule, text, StringComparison.Ordinal);
            Assert.Contains(OriginRule, text, StringComparison.Ordinal);
        }
    }

    private static (string Id, string LocationText)[] ExpectedDiagnostics(SwitchForm form, SwitchShape shape)
    {
        if (shape != SwitchShape.Incomplete)
        {
            return Array.Empty<(string, string)>();
        }

        return form == SwitchForm.Statement
            ? new[] { ("GS0100", "F"), ("GS0178", "switch") }
            : new[] { ("GS0177", "switch") };
    }

    private static string BuildSource(EnumOrigin origin, SwitchForm form, SwitchShape shape)
    {
        var (declaration, typeName, members) = origin switch
        {
            EnumOrigin.ImportedFlags => (
                "import System",
                "StringSplitOptions",
                new[] { "None", "RemoveEmptyEntries", "TrimEntries" }),
            EnumOrigin.UserFlags => (
                "import System\n@Flags\nenum Access { None = 0, Read = 1, Write = 2 }",
                "Access",
                new[] { "None", "Read", "Write" }),
            _ => (
                "enum Access { None, Read, Write }",
                "Access",
                new[] { "None", "Read", "Write" }),
        };

        var arms = BuildArms(typeName, members, form, shape);
        var function = form == SwitchForm.Statement
            ? $"func F(x {typeName}) int32 {{\n    switch x {{\n{arms}    }}\n}}"
            : $"func F(x {typeName}) int32 {{\n    return switch x {{\n{arms}    }}\n}}";

        return $"package Issue2941.{origin}.{form}.{shape}\n{declaration}\n{function}\n";
    }

    private static string BuildArms(
        string typeName,
        IReadOnlyList<string> members,
        SwitchForm form,
        SwitchShape shape)
    {
        var selected = shape == SwitchShape.Incomplete || shape == SwitchShape.HasDefault
            ? new[] { members[0] }
            : members.ToArray();
        var builder = new StringBuilder();
        for (var i = 0; i < selected.Length; i++)
        {
            AppendArm(builder, typeName, selected[i], i, form);
            if (shape == SwitchShape.DuplicateArm && i == 0)
            {
                AppendArm(builder, typeName, selected[i], 99, form);
            }
        }

        if (shape == SwitchShape.HasDefault)
        {
            builder.Append(form == SwitchForm.Statement
                ? "        default { return 9 }\n"
                : "        default: 9\n");
        }

        return builder.ToString();
    }

    private static void AppendArm(
        StringBuilder builder,
        string typeName,
        string member,
        int value,
        SwitchForm form)
    {
        builder.Append(form == SwitchForm.Statement
            ? $"        case {typeName}.{member} {{ return {value} }}\n"
            : $"        case {typeName}.{member}: {value}\n");
    }

    private static string FindRepoRoot()
    {
        var directory = Path.GetDirectoryName(typeof(Issue2941FlagsEnumExhaustivenessTests).Assembly.Location);
        while (!string.IsNullOrEmpty(directory))
        {
            if (File.Exists(Path.Combine(directory, "GSharp.sln")))
            {
                return directory;
            }

            directory = Path.GetDirectoryName(directory);
        }

        return Environment.CurrentDirectory;
    }

    public enum EnumOrigin
    {
        ImportedFlags,
        UserFlags,
        PlainEnum,
    }

    public enum SwitchForm
    {
        Statement,
        Expression,
    }

    public enum SwitchShape
    {
        NameComplete,
        Incomplete,
        HasDefault,
        DuplicateArm,
    }
}
