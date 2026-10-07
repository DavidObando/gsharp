// <copyright file="Issue4816SelfMigrationNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4816SelfMigrationNullabilityTests
{
    [Fact]
    public void ObliviousReads_KeepTheirNonNullUseSitesWhenSelfMigrated()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Fixture.cs", """
                #nullable disable
                using System;
                using System.Linq;
                using System.Reflection;

                public static class Fixture
                {
                    private static string Accept(string value) => value;
                    private static string[] Values() =>
                        new[] { typeof(string) }.Select(type => type.FullName).ToArray();

                    public static void Run(string[] values, MethodInfo[][] methods, bool include)
                    {
                        _ = Accept(values[0]);
                        var projected = Values();
                        _ = Accept(projected[0]);
                        _ = Accept(projected.Single());
                        _ = Accept(projected.ToString());
                        _ = Accept(projected.Aggregate("seed", (acc, _) => acc));
                        string[] explicitProjected = Values();
                        _ = Accept(explicitProjected[0]);
                        _ = methods[0].Select(method => method.Name).ToArray();
                        _ = typeof(string).GetProperty("Length").GetValue("x").ToString();
                        _ = Convert.ToString(1);
                        _ = new { Name = "fixed" };
                        _ = new { Name = typeof(string).FullName };
                        _ = new { Cast = (object)"fixed" as string };
                        _ = new { Cast = (string)null };
                        string maybe = null;
                        var nullableShape = new { Value = maybe };
                        var nonNullableShape = new { Value = "fixed" };
                        nullableShape = nonNullableShape;
                        string path = typeof(string).FullName;
                        _ = new { Path = path };
                        _ = new { Emitted = include ? new { Path = "fixed" } : null };
                    }
                }

                #nullable enable
                public static class AnnotatedFixture
                {
                    public static object Nullable(string? value, string?[] values) =>
                        new { Name = value, Values = values };
                    public static object NonNull(string value, string[] values) =>
                        new { Name = value, Values = values };
                    public static object DefaultValue(bool include) =>
                        new { Count = include ? default : 1 };
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.DoesNotContain("""(nil as string)!!""", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("""Convert!!""", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("""projected.ToString()!!""", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("""projected.Aggregate("seed", (acc, _) -> acc)!!""", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }
}
