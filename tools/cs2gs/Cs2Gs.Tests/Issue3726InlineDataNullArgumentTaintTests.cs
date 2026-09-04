// <copyright file="Issue3726InlineDataNullArgumentTaintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3726: a data-driving attribute is a null-WRITING site. An xunit
/// theory declared <c>[InlineData(null, null)] void T(string a, string b)</c>
/// really is called with <c>null</c> for both parameters, but the attribute
/// argument was not part of the taint-source set, so oblivious parameters kept
/// their non-nullable <c>string</c> rendering while cs2gs emitted
/// <c>@InlineData(nil, nil)</c> beside them — an internally inconsistent file
/// gsc correctly rejected (GS0274).
/// <para>
/// The repair follows #3706's shape: an attribute-driven, DECLARATION-only
/// promotion. A <c>null</c> in a positional <c>params object[]</c> data
/// attribute taints the parameter it lines up with, and the existing edge
/// machinery carries that taint onward — bridging the emitted <c>nil</c> with
/// <c>!!</c> instead would convert clean behaviour into a runtime throw.
/// </para>
/// </summary>
public class Issue3726InlineDataNullArgumentTaintTests
{
    // A stand-in for xunit's `[InlineData]`: the mechanical shape the rule
    // keys off is a `params object[]` constructor, not the xunit name.
    private const string DataAttributeDeclarations = @"
using System;

namespace Demo
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    public sealed class InlineDataAttribute : Attribute
    {
        public InlineDataAttribute(params object[] data)
        {
            this.Data = data;
        }

        public object[] Data { get; }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TheoryAttribute : Attribute
    {
    }
}";

    [Fact]
    public void NullInlineDataArgument_PromotesThePositionallyMatchingParameter()
    {
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        [Theory]
        [InlineData(null, null)]
        [InlineData("""", null)]
        [InlineData(""  protocol.log  "", ""protocol.log"")]
        public void GetLogPath(string tracePath, string expected)
        {
            System.Console.WriteLine(tracePath);
            System.Console.WriteLine(expected);
        }
    }
}",
            out string declarations);

        Assert.Contains("GetLogPath(tracePath string?, expected string?)", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ANonNullInlineDataColumn_LeavesItsParameterNonNullable()
    {
        // Only the columns that actually carry a `null` are evidence: the
        // second parameter is never supplied null, so it must stay `string`.
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        [Theory]
        [InlineData(null, ""a"")]
        [InlineData(""b"", ""c"")]
        public void Check(string maybe, string always)
        {
            System.Console.WriteLine(maybe);
            System.Console.WriteLine(always);
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(maybe string?, always string)", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ValueTypedColumns_AreNotPromoted()
    {
        // `T?` for a value type means `Nullable<T>` — a different declaration
        // entirely — so the reference-type guard must keep an `int` column out.
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        [Theory]
        [InlineData(null, 1)]
        public void Check(string text, int count)
        {
            System.Console.WriteLine(text);
            System.Console.WriteLine(count);
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(text string?, count int32)", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ANullDataRowValue_WidensAnArrayLiteralElementInsteadOfBridgingIt()
    {
        // The #3704 shape the promotion could otherwise create: the row really
        // does pass null, and the C# filters it out afterwards, so bridging the
        // array element with `!!` would throw before the filter ever ran. An
        // array literal's element type is inferred AT the literal (#3682), so
        // widening it is the faithful repair.
        string printed = Translate(
            @"
using System.Linq;

namespace Demo
{
    public class ProgramTests
    {
        [Theory]
        [InlineData(null, ""/target:library"")]
        [InlineData(""/optimize+"", ""/target:library"")]
        public void Check(string flag, string target)
        {
            var arguments = new[] { target, flag }
                .Where(argument => argument is not null)
                .ToArray();
            System.Console.WriteLine(arguments.Length);
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(flag string?, target string)", printed);
        Assert.Contains("[]string?{", printed);
        Assert.DoesNotContain("flag!!", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void AWholeArrayNullRow_PromotesTheFirstParameter()
    {
        // Issue #3880: `[InlineData(null)]` binds the lone `null` as the params
        // ARRAY, not as one element, and #3726 read that as naming no position.
        // gsc does not agree: its GS0274 check reads the emitted
        // `@InlineData(nil)` positionally and rejects a non-nullable parameter
        // 0 — so the file cs2gs emitted contradicted itself, which is exactly
        // the inconsistency #3726 set out to remove. Three sites in cs2gs's own
        // test suite failed to compile after migration on this.
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        [Theory]
        [InlineData(null)]
        [InlineData("""")]
        public void Check(string name)
        {
            System.Console.WriteLine(Normalize(name));
        }

        private static string Normalize(string name)
        {
            return name == null ? string.Empty : name.Trim();
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(name string?)", printed);
        Assert.Contains("@InlineData(nil)", printed);

        // The #3704 guard: the row really does pass nil, so bridging the read
        // with `!!` would turn a passing test into a runtime throw. `Normalize`
        // is an oblivious sibling (this project has nullable disabled) that
        // null-checks its own argument, exactly like the three cs2gs test
        // methods this promotion unblocks.
        Assert.Contains("Normalize(name)", printed);
        Assert.DoesNotContain("Normalize(name!!)", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void AWholeArrayNullRow_ClaimsNothingBeyondTheFirstParameter()
    {
        // The claim is deliberately as narrow as gsc's own: a whole-array null
        // is positional evidence for parameter 0 only. Widening every parameter
        // would promote columns no row ever supplies null for.
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        [Theory]
        [InlineData(null)]
        public void Check(string first, string second)
        {
            System.Console.WriteLine(first);
            System.Console.WriteLine(second);
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(first string?, second string)", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    // Returns the printed consumer file, and hands back the printed attribute
    // declarations too so callers can bind the pair.
    private static string Translate(string source, out string printedDeclarations)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Attributes.cs", DataAttributeDeclarations), ("Tests.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics));

        printedDeclarations = Print(project, 0);
        return Print(project, 1);
    }

    private static string Print(LoadedCSharpProject project, int documentIndex)
    {
        LoadedDocument document = project.Documents[documentIndex];
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
