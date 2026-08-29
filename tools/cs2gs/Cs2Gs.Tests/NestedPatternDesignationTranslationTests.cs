// <copyright file="NestedPatternDesignationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// A designation on a NESTED untyped property pattern
/// (<c>{ ClrType: { IsGenericType: true } closedClr }</c>) must survive
/// translation as G#'s native ADR-0166 after-brace designator. The untyped
/// recursive-pattern branch used to drop <c>Designation</c> entirely,
/// orphaning every body reference to the binder (GS0125/GS0159) — the
/// 2026-08-29 selfmig nightly regression on
/// <c>TupleElementNamesReader.cs</c> that cascaded migrated
/// <c>src/Core</c> compile failures into 18 downstream apps.
/// </summary>
public class NestedPatternDesignationTranslationTests
{
    private const string HolderSource = """
        using System;

        namespace Demo
        {
            public sealed class Holder
            {
                public Type? ClrType { get; init; }
            }

            public static class Repro
            {
        """;

    [Fact]
    public void SwitchStatement_NestedPropertyPatternDesignation_Preserved()
    {
        string printed = Translate(HolderSource + """
                public static int Classify(Holder holder)
                {
                    switch (holder)
                    {
                        case { ClrType: { IsGenericType: true, IsGenericTypeDefinition: false } closedClr }:
                            return closedClr.GetGenericArguments().Length;

                        default:
                            return -1;
                    }
                }

                public static int Run()
                {
                    var generic = new Holder { ClrType = typeof(System.Collections.Generic.List<int>) };
                    return (Classify(generic) * 10) + Classify(new Holder()) + 1;
                }
            }
        }
        """);

        Assert.Contains(
            "case { ClrType: { IsGenericType: true, IsGenericTypeDefinition: false } closedClr }",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("closedClr.GetGenericArguments().Length", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);

        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(Demo.Repro.Run())",
            "10");
    }

    [Fact]
    public void IsPattern_NestedPropertyPatternDesignation_Preserved()
    {
        string printed = Translate(HolderSource + """
                public static int ViaIs(Holder holder)
                {
                    if (holder is { ClrType: { IsGenericType: true } closedClr })
                    {
                        return closedClr.GetGenericArguments().Length;
                    }

                    return -1;
                }
            }
        }
        """);

        Assert.Contains(
            "is { ClrType: { IsGenericType: true } closedClr }",
            printed,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void SwitchExpression_NestedPropertyPatternDesignation_Preserved()
    {
        string printed = Translate(HolderSource + """
                public static int Via(Holder holder) => holder switch
                {
                    { ClrType: { IsGenericType: true } closedClr } => closedClr.GetGenericArguments().Length,
                    _ => -1,
                };
            }
        }
        """);

        Assert.Contains(
            "case { ClrType: { IsGenericType: true } closedClr }:",
            printed,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
