// <copyright file="Issue4356NestedPatternReceiverTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable
using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4356: a property pattern lowers to <c>x != nil &amp;&amp; x.Member …</c>.
/// When <c>x</c> is itself a member-access chain over a stated-nullable
/// imported member, gsc does not narrow it after the guard (only a chain of
/// stable links narrows), so the member reads assert the receiver. They used
/// to bind only because gsc's member lookup let any chained imported read
/// through regardless of its stated nullability; found by the hot-core
/// self-migration guard on <c>src/Core/CodeAnalysis/Binding/MemberLookup.cs</c>.
/// </summary>
public sealed class Issue4356NestedPatternReceiverTranslationTests
{
    [Fact]
    public void NestedSubpatternOverImportedNullableMember_AssertsTheGuardedReceiver()
    {
        string printed = Translate("""
            #nullable enable
            using System.Reflection;

            namespace Sample;

            public static class Probe
            {
                public static bool IsWidening(MethodInfo candidate)
                    => candidate is { IsAbstract: true, DeclaringType: { IsInterface: true, IsGenericType: false } };
            }
            """);

        Assert.Contains("candidate.DeclaringType != nil", printed, StringComparison.Ordinal);
        Assert.Contains("candidate.DeclaringType!!.IsInterface", printed, StringComparison.Ordinal);
        Assert.Contains("candidate.DeclaringType!!.IsGenericType", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ExtendedPropertySubpatternOverImportedNullableMember_AssertsTheGuardedReceiver()
    {
        // The flattened spelling of the nested case above (`{ DeclaringType.IsInterface: true }`)
        // takes the extended-property path, which guards each nullable
        // intermediate with its own `!= nil` and must then assert it for the
        // next link, exactly as the nested path does.
        string printed = Translate("""
            #nullable enable
            using System.Reflection;

            namespace Sample;

            public static class Probe
            {
                public static bool IsWidening(MethodInfo candidate)
                    => candidate is { IsAbstract: true, DeclaringType.IsInterface: true };
            }
            """);

        // The printer wraps this chain across lines; compare with whitespace collapsed.
        string flat = System.Text.RegularExpressions.Regex.Replace(printed, @"\s+", " ");
        Assert.Contains("candidate.DeclaringType != nil && candidate.DeclaringType!!.IsInterface == true", flat, StringComparison.Ordinal);
    }

    [Fact]
    public void LocalSubject_IsNarrowedByTheGuard_AndNotAsserted()
    {
        string printed = Translate("""
            #nullable enable
            using System;

            namespace Sample;

            public static class Probe
            {
                public static bool IsInterface(Type? type) => type is { IsInterface: true };
            }
            """);

        Assert.Contains("type != nil && type.IsInterface", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("type!!", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit translated = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(translated);
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip:\n" +
                string.Join(Environment.NewLine, roundTrip.Errors) +
                "\n\n" + printed);
        return printed;
    }
}
