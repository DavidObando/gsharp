// <copyright file="Issue4719CastNullTupleLeafTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4719CastNullTupleLeafTests
{
    [Theory]
    [InlineData("(string)null")]
    [InlineData("((string)null)")]
    [InlineData("(string)default")]
    [InlineData("(string)default(string)")]
    [InlineData("(string)(object)null")]
    [InlineData("choose ? (string)null : \"x\"")]
    [InlineData("choose switch { true => (string)null, false => \"x\" }")]
    public void CastNullTupleLeaf_PromotesOnlyTheNullBearingLeaf(string value)
    {
        string printed = Translate($$"""
            public static class Obj {
                public static ((string Text, string Keep) Names, int Code) Rows(bool choose) {
                    ((string Text, string Keep) Names, int Code) Missing() {
                        return choose ? (({{value}}, "keep"), 1) : (("x", "keep"), 2);
                    }
                    return Missing();
                }
            }
            """);

        Assert.Contains("let Missing = func () (Names (Text string?, Keep string), Code int32)", printed);
        Assert.Contains("func Rows(choose bool) (Names (Text string?, Keep string), Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void CastNullTupleAndScalarReturns_PreserveRuntimeNull()
    {
        string printed = Translate("""
            public static class Obj {
                public static string Missing() => (string)null;
                public static string Forward() => Missing();
                public static (string Text, int Code) Row() => ((string)null, 1);
                public static bool Run() {
                    var row = Row();
                    return row.Text is null && row.Code == 1 && Forward() is null;
                }
            }
            """);

        Assert.Contains("func Missing() string?", printed);
        Assert.Contains("func Forward() string?", printed);
        Assert.Contains("func Row() (Text string?, Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.False(result.Diagnostics.Any(diagnostic => diagnostic.IsError), string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Null(result.UnhandledException);
        Assert.Equal(true, result.Value);
    }

    [Theory]
    [InlineData("(string)(object)\"keep\"")]
    [InlineData("(string)null ?? \"keep\"")]
    [InlineData("(int)(object)null")]
    [InlineData("(Box)(string)null")]
    public void CastWithoutNullResult_DoesNotPromoteItsTupleLeaf(string value)
    {
        string type = value.StartsWith("(int)", StringComparison.Ordinal) ? "int"
            : value.StartsWith("(Box)", StringComparison.Ordinal) ? "Box" : "string";
        string mappedType = type == "int" ? "int32" : type;
        string printed = Translate($$"""
            public sealed class Box {
                public static explicit operator Box(string text) => new Box();
            }
            public static class Obj {
                public static ({{type}} Value, int Code) Row() => ({{value}}, 1);
            }
            """);

        Assert.Contains($"func Row() (Value {mappedType}, Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
