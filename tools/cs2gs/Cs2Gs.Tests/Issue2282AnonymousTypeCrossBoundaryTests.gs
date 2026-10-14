// <copyright file="Issue2282AnonymousTypeCrossBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Text.RegularExpressions
import Xunit

/// Regression tests for issue #2282: a C# anonymous type with named
/// properties (`new { Id = ..., Name = ... }`) mistranslated to an
/// unnamed positional G# tuple, discarding the member names so a later
/// `x.Id` access failed to bind (GS0159, "Cannot find function Id" —
/// because a G# tuple's positional access is the only surviving shape and
/// `x.Id` parses/binds as an unresolved call, not a member).
///
/// The root repro (17 instances in Oahu.Data EF-migration files) is an
/// EF-Core-style `MigrationBuilder.CreateTable<TColumns>` call: the
/// `columns` lambda's anonymous-typed return value generic-infers
/// `TColumns`, and the `constraints` lambda's parameter type is
/// `CreateTableBuilder<TColumns>` — the SAME anonymous type crosses
/// from one lambda's return position into another lambda's parameter TYPE via
/// generic inference. Neither a named tuple (G# tuples have no named-element
/// syntax) nor the `object { }` anonymous-value literal (issue #2224; no
/// type-annotation spelling) can express a type that crosses a real type
/// boundary like this — only a synthesized, nameable `data class`
/// (issue #2282's fix) can.
open class Issue2282AnonymousTypeCrossBoundaryTests {
    @Fact
    func AnonymousType_CrossLambdaBoundary_UsesSynthesizedDataClassAsSharedType() {
        let printed = TranslateUnit(`
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
                name: "Books",
                columns: table => new
                {
                    Id = table.Column<int>(name: "Id"),
                    Title = table.Column<string>(name: "Title")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Books", x => x.Id);
                });
        }
    }
}`)
        // The construction site and the CROSS-LAMBDA type-position uses
        // (the constraints lambda's parameter type, and the nested PrimaryKey
        // lambda's parameter type) all reference the SAME synthesized type —
        // proving the type is nameable across the boundary, not just usable
        // as a same-scope value.
        let name = Regex.Match(printed, "data class (AnonymousType\\d+_[0-9A-F]{16})\\(").Groups[1].Value
        Assert.Contains("$name(table.Column", printed)
        Assert.Contains("CreateTableBuilder[$name]", printed)
        Assert.Contains("(x $name)", printed)
        Assert.Contains("data class $name(Id int32, Title string)", printed)
        // Named-member access resolves directly (no GS0159 "Cannot find
        // function Id" — the original bug's symptom of falling back to an
        // unresolved call because the receiver had no such member).
        Assert.Contains("x.Id", printed)
        Assert.DoesNotContain("x.Item1", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
