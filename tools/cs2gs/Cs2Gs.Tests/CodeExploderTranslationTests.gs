// <copyright file="CodeExploderTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Targeted translator regressions discovered by the code-exploder corpus
/// integration tracked by issue #3395.
open class CodeExploderTranslationTests {
    @Fact
    func FlowNarrowedCollectionElement_UsesGSharpSmartCast() {
        let printed = TranslateUnit(`#nullable enable
namespace Demo;

public static class Args
{
    public static string[] Build(string? gitRef)
    {
        if (gitRef is null)
        {
            throw new System.ArgumentNullException(nameof(gitRef));
        }

        return ["--branch", gitRef];
    }
}`)
        Assert.True(printed.Contains("[]string{\"--branch\", gitRef}", StringComparison.Ordinal), printed)
        Assert.DoesNotContain("gitRef!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func NamedTupleExtendedPropertyPattern_UsesPositionalField() {
        let printed = TranslateUnit(`#nullable enable
namespace Demo;

public static class Summaries
{
    public static bool HasProse((string Component, string ProseMd) summary) =>
        summary is { ProseMd.Length: > 0 };
}`)
        Assert.Contains("Item2", printed)
        Assert.DoesNotContain("ProseMd:", printed)
    }

    @Fact
    func FlowNarrowedAnonymousProperty_IsAsserted() {
        let printed = TranslateUnit(`#nullable enable
namespace Demo;

public sealed class Callout
{
    public string? Md { get; init; }
}

public static class Renderer
{
    public static string Render(Callout callout)
    {
        if (callout is { Md: not null })
        {
            var value = new { md = callout.Md };
            return value.md;
        }

        return "";
    }
}`)
        Assert.True(printed.Contains("(callout.Md!!)", StringComparison.Ordinal), printed)
    }

    @Fact
    func NullableReferenceObjectCast_PreservesCoalesceType() {
        let printed = TranslateUnit(`#nullable enable
namespace Demo;

public static class Values
{
    public static object DbValue(string? text) =>
        (object?)text ?? System.DBNull.Value;
}`)
        Assert.Contains("object?(text) ?? DBNull.Value", printed)
        Assert.DoesNotContain("let __cast", printed)
    }

    @Fact
    func NullableValueTypedNullCast_UsesDefault() {
        let printed = TranslateUnit(`#nullable enable
namespace Demo;

public static class Routes
{
    public static object Build() => new { ParentId = (System.Guid?)null };
}`)
        Assert.Contains("default(Guid?)", printed)
        Assert.DoesNotContain("Guid?(nil)", printed)
    }

    @Fact
    func NullableNamedTupleMemberBinding_UsesPositionalField() {
        let printed = TranslateUnit(`#nullable enable
namespace Demo;

public static class Summaries
{
    public static string? Get((string ProseMd, string? Json)? summary) =>
        summary?.ProseMd;
}`)
        Assert.Contains("summary?.Item1", printed)
        Assert.DoesNotContain("summary?.ProseMd", printed)
    }

    @Fact
    func PrefixIncrementArgument_UsesAssignmentExpression() {
        let printed = TranslateUnit(`namespace Demo;

public static class Events
{
    private static void Publish(int sequence)
    {
    }

    public static void Send()
    {
        var sequence = 0;
        Publish(++sequence);
    }
}`)
        Assert.True(printed.Contains(" += 1))", StringComparison.Ordinal), printed)
        Assert.DoesNotContain("Publish(++sequence)", printed)
    }

    @Fact
    func ExplicitGenericNumericArgument_CoercesLiteral() {
        let printed = TranslateUnit(`namespace Demo;

public static class Values
{
    private static T Identity<T>(T value) => value;

    public static long Build() => Identity<long>(1);
}`)
        Assert.Contains("Identity[int64](int64(1))", printed)
    }

    @Fact
    func StringConstruction_UsesImportedClrTypeName() {
        let printed = TranslateUnit(`namespace Demo;

public static class Text
{
    public static string Build(char[] chars) => new string(chars);
}`)
        Assert.Contains("String(chars)", printed)
        Assert.DoesNotContain("System.String(chars)", printed)
    }

    @Fact
    func VoidDelegateDiscardAssignment_EmitsRhsStatement() {
        let printed = TranslateUnit(`using System;
using System.Threading.Tasks;

namespace Demo;

public static class Events
{
    private static Task RelayAsync() => Task.CompletedTask;

    public static EventHandler Build() =>
        (_, args) => _ = RelayAsync();
}`)
        Assert.Contains("RelayAsync()", printed)
        Assert.DoesNotContain("_ = RelayAsync()", printed)
    }

    @Fact
    func BlockLambdaSingleUnderscoreParameter_IsRenamed() {
        let printed = TranslateUnit(`using System;
using System.Threading.Tasks;

namespace Demo;

public static class Events
{
    private static Task RelayAsync() => Task.CompletedTask;

    public static EventHandler Build() =>
        (_, args) =>
        {
            _ = RelayAsync();
        };
}`)
        Assert.Contains("__underscore object", printed)
        Assert.Contains("RelayAsync()", printed)
        Assert.DoesNotContain("_ = RelayAsync()", printed)
    }

    @Fact
    func ReassignedLambdaParameter_GetsMutableShadow() {
        let printed = TranslateUnit(`using System;

namespace Demo;

public static class Values
{
    public static Func<int, int> Build() =>
        value =>
        {
            value += 1;
            return value;
        };
}`)
        Assert.Contains("var value = value", printed)
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
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }
    }
}
