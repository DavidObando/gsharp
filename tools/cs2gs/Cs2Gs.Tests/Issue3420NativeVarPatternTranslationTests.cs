// <copyright file="Issue3420NativeVarPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Translation and runtime parity for native total <c>var name</c> patterns.</summary>
public sealed class Issue3420NativeVarPatternTranslationTests
{
    [Fact]
    public void CoreShapes_EmitNativeVarPatternsWithoutSpillsOrTrueResidue()
    {
        string printed = Translate(Source);

        Assert.Contains(
            "arguments[i] is BoundDefaultExpression { Type: var defType } && defType == TypeSymbol.Error",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "imp.Declaration is { SyntaxTree: var declTree } && declTree == tree",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "address is BoundAddressOfExpression { Operand: { Type: var pointee } } && pointee == TypeSymbol.Error",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("[var firstValue, ..]", printed, StringComparison.Ordinal);
        Assert.Contains("case var fallback:", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("&& true", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if true", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NativeVarPatterns_CompileAndRunWithCSharpParity()
    {
        string printed = Translate(Source);

        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C.Run())",
            "error,tree,nil,7,address,switch");
    }

    private const string Source = """
        using System;

        namespace Demo
        {
            public class TypeSymbol
            {
                public static readonly TypeSymbol Error = new TypeSymbol();
            }

            public sealed class BoundDefaultExpression
            {
                public TypeSymbol Type { get; init; } = new TypeSymbol();
            }

            public sealed class SyntaxTree { }

            public sealed class Declaration
            {
                public SyntaxTree SyntaxTree { get; init; } = new SyntaxTree();
            }

            public sealed class Import
            {
                public string Target { get; init; } = "";
                public Declaration? Declaration { get; init; }
            }

            public sealed class Operand
            {
                public TypeSymbol Type { get; init; } = new TypeSymbol();
            }

            public sealed class BoundAddressOfExpression
            {
                public Operand Operand { get; init; } = new Operand();
            }

            public static class C
            {
                public static string Run()
                {
                    var arguments = new[]
                    {
                        new BoundDefaultExpression { Type = TypeSymbol.Error },
                    };
                    int i = 0;
                    var tree = new SyntaxTree();
                    var imp = new Import
                    {
                        Target = "go",
                        Declaration = new Declaration { SyntaxTree = tree },
                    };

                    string first =
                        arguments[i] is BoundDefaultExpression { Type: var defType }
                        && defType == TypeSymbol.Error
                            ? "error"
                            : "other";
                    string second =
                        string.Equals(imp.Target, "go", StringComparison.Ordinal)
                        && imp.Declaration is { SyntaxTree: var declTree }
                        && declTree == tree
                            ? "tree"
                            : "other";
                    object? value = null;
                    string third = value is var captured && captured is null ? "nil" : "other";
                    int[] values = { 7, 8 };
                    string fourth = values is [var firstValue, ..] ? firstValue.ToString() : "empty";
                    var address = new BoundAddressOfExpression
                    {
                        Operand = new Operand { Type = TypeSymbol.Error },
                    };
                    string fifth =
                        address is BoundAddressOfExpression { Operand.Type: var pointee }
                        && pointee == TypeSymbol.Error
                            ? "address"
                            : "other";
                    string sixth = imp switch
                    {
                        { Declaration: { SyntaxTree: var switchTree } } when switchTree == tree => "switch",
                        var fallback => "fallback",
                    };

                    return $"{first},{second},{third},{fourth},{fifth},{sixth}";
                }
            }
        }
        """;

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }
}
