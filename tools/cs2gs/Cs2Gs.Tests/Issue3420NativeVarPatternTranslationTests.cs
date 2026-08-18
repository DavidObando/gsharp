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

    [Fact]
    public void ReassignedSwitchVarPatterns_MaterializeMutableArmLocals()
    {
        string printed = Translate(ReassignedSwitchSource);

        Assert.Contains("case var stableValue:", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("case var exprValue:", printed, StringComparison.Ordinal);
        Assert.Contains("var exprValue int32 = __pattern", printed, StringComparison.Ordinal);
        Assert.Contains("var stmtValue int32 = __pattern", printed, StringComparison.Ordinal);
        Assert.Contains("var nestedValue int32 = __pattern", printed, StringComparison.Ordinal);
        Assert.Contains("var listValue int32 = __pattern", printed, StringComparison.Ordinal);
        Assert.Contains("var typedValue int32 =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C.Run(6))",
            "7,8,9,10,11,6");
    }

    [Fact]
    public void ReassignedSwitchVarPatternInGuard_ReportsUnsupportedWithoutInvalidBinding()
    {
        (string printed, TranslationContext context) = TranslateWithDiagnostics(
            """
            namespace Demo
            {
                public static class C
                {
                    public static int Run(int input) => input switch
                    {
                        var guardValue when (guardValue = guardValue + 1) > 0 => guardValue,
                        _ => 0,
                    };
                }
            }
            """);

        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "switch pattern variable 'guardValue' is reassigned in a when guard",
                    StringComparison.Ordinal));
        Assert.DoesNotContain("__pattern0 =", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
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

    private const string ReassignedSwitchSource = """
        using System;

        namespace Demo
        {
            public sealed class Box
            {
                public int Value { get; init; }
            }

            public static class C
            {
                public static string Run(int input)
                {
                    string expression = input switch
                    {
                        var exprValue => (exprValue = exprValue + 1).ToString(),
                    };

                    int statementResult = 0;
                    switch (input)
                    {
                        case var stmtValue:
                            stmtValue += 2;
                            statementResult = stmtValue;
                            break;
                    }

                    int nested = new Box { Value = input } switch
                    {
                        { Value: var nestedValue } => nestedValue = nestedValue + 3,
                    };
                    int listed = new[] { input } switch
                    {
                        [var listValue] => listValue = listValue + 4,
                        _ => 0,
                    };
                    object boxed = new Box { Value = input };
                    int typed = boxed switch
                    {
                        Box { Value: var typedValue } => typedValue = typedValue + 5,
                        _ => 0,
                    };
                    string stable = input switch
                    {
                        var stableValue => stableValue.ToString(),
                    };

                    return $"{expression},{statementResult},{nested},{listed},{typed},{stable}";
                }
            }
        }
        """;

    private static string Translate(string source)
    {
        (string printed, TranslationContext context) = TranslateWithDiagnostics(source);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }

    private static (string Printed, TranslationContext Context) TranslateWithDiagnostics(string source)
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
        return (printed, context);
    }
}
