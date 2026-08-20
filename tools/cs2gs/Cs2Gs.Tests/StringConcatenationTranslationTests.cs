// <copyright file="StringConcatenationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translation tests for C# string concatenation (issue #914). C# `a + b`
/// implicitly converts non-<c>string</c> operands through its predefined
/// concatenation operators. G# handles <c>char</c> natively; remaining operand
/// types are rewritten to explicit <c>ToString()</c> calls.
/// </summary>
public class StringConcatenationTranslationTests
{
    [Fact]
    public void UserObjectConcatenatedWithString_GetsToStringCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Indent { public override string ToString() => ""i""; }
    public class C
    {
        public string F(Indent ind, string s) => ind + s;
    }
}");

        Assert.Contains("ind.ToString() + s", printed);
    }

    [Fact]
    public void StringConcatenatedWithUserObject_GetsToStringCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Indent { public override string ToString() => ""i""; }
    public class C
    {
        public string F(Indent ind, string s) => s + ind;
    }
}");

        Assert.Contains("s + ind.ToString()", printed);
    }

    [Fact]
    public void PrimitiveConcatenatedWithString_GetsToStringCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public string F(int n) => ""n="" + n;
    }
}");

        Assert.Contains("\"n=\" + n.ToString()", printed);
    }

    [Fact]
    public void CharConcatenation_UsesNativeGSharpOperator()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public string F(char ch)
        {
            string value = ""root"";
            value += ch;
            return ch + value;
        }
    }
}");

        Assert.Contains("value += ch", printed);
        Assert.Contains("return ch + value", printed);
        Assert.DoesNotContain("ch.ToString()", printed);
    }

    [Fact]
    public void ChainedConcatenation_ConvertsOnlyNonStringOperands()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Indent { public override string ToString() => ""i""; }
    public class C
    {
        public string F(Indent ind, string m, string d) => ind + m + d;
    }
}");

        // Left-associative: only the leading non-string `ind` needs conversion;
        // the remaining `+ m + d` are string-to-string.
        Assert.Contains("ind.ToString() + m + d", printed);
    }

    [Fact]
    public void PureStringConcatenation_IsUnchanged()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public string F(string a, string b) => a + b;
    }
}");

        Assert.Contains("a + b", printed);
        Assert.DoesNotContain("ToString", printed);
    }

    [Fact]
    public void NumericAddition_IsNotTreatedAsConcatenation()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int F(int a, int b) => a + b;
    }
}");

        Assert.Contains("a + b", printed);
        Assert.DoesNotContain("ToString", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
