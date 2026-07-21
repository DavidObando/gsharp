// <copyright file="Issue2282AnonymousTypeCrossBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #2282: a C# anonymous type with named
/// properties (<c>new { Id = ..., Name = ... }</c>) mistranslated to an
/// unnamed positional G# tuple, discarding the member names so a later
/// <c>x.Id</c> access failed to bind (GS0159, "Cannot find function Id" —
/// because a G# tuple's positional access is the only surviving shape and
/// <c>x.Id</c> parses/binds as an unresolved call, not a member).
/// <para>
/// The root repro (17 instances in Oahu.Data EF-migration files) is an
/// EF-Core-style <c>MigrationBuilder.CreateTable&lt;TColumns&gt;</c> call: the
/// <c>columns</c> lambda's anonymous-typed return value generic-infers
/// <c>TColumns</c>, and the <c>constraints</c> lambda's parameter type is
/// <c>CreateTableBuilder&lt;TColumns&gt;</c> — the SAME anonymous type crosses
/// from one lambda's return position into another lambda's parameter TYPE via
/// generic inference. Neither a named tuple (G# tuples have no named-element
/// syntax) nor the <c>object { }</c> anonymous-value literal (issue #2224; no
/// type-annotation spelling) can express a type that crosses a real type
/// boundary like this — only a synthesized, nameable <c>data class</c>
/// (issue #2282's fix) can.
/// </para>
/// </summary>
public class Issue2282AnonymousTypeCrossBoundaryTests
{
    [Fact]
    public void AnonymousType_CrossLambdaBoundary_UsesSynthesizedDataClassAsSharedType()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public sealed class ColumnsBuilder
    {
        public T Column<T>(string name) => default!;
    }

    public sealed class CreateTableBuilder<TColumns>
    {
        public void PrimaryKey(string name, Func<TColumns, object> columns) { }
    }

    public sealed class MigrationBuilder
    {
        public void CreateTable<TColumns>(
            string name,
            Func<ColumnsBuilder, TColumns> columns,
            Action<CreateTableBuilder<TColumns>> constraints)
        {
        }
    }

    public sealed class Migration
    {
        public void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: ""Books"",
                columns: table => new
                {
                    Id = table.Column<int>(name: ""Id""),
                    Title = table.Column<string>(name: ""Title"")
                },
                constraints: table =>
                {
                    table.PrimaryKey(""PK_Books"", x => x.Id);
                });
        }
    }
}");

        // The construction site and the CROSS-LAMBDA type-position uses
        // (the constraints lambda's parameter type, and the nested PrimaryKey
        // lambda's parameter type) all reference the SAME synthesized type —
        // proving the type is nameable across the boundary, not just usable
        // as a same-scope value.
        string name = Regex.Match(
            printed,
            @"data class (AnonymousType\d+_[0-9A-F]{16})\(").Groups[1].Value;
        Assert.Contains($"{name}(table.Column", printed);
        Assert.Contains($"CreateTableBuilder[{name}]", printed);
        Assert.Contains($"(x {name})", printed);
        Assert.Contains($"data class {name}(Id int32, Title string)", printed);

        // Named-member access resolves directly (no GS0159 "Cannot find
        // function Id" — the original bug's symptom of falling back to an
        // unresolved call because the receiver had no such member).
        Assert.Contains("x.Id", printed);
        Assert.DoesNotContain("x.Item1", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(System.Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
