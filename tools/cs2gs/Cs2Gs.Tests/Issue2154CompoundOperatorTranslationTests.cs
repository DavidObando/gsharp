// <copyright file="Issue2154CompoundOperatorTranslationTests.cs" company="GSharp">
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
/// Issue #2154: cs2gs already emitted a C# compound-assignment EXPRESSION
/// (<c>lhs op= rhs</c>) verbatim as its G# translation target — including when
/// the LHS is a member access into a type with a user-defined operator
/// overload (<c>obj.Field *= 2</c>) — via the generic
/// <c>AssignmentStatement(target, rhs, op)</c> path in
/// <c>TranslateExpressionStatement</c>. That emission was correct G# syntax,
/// but it failed to ROUND-TRIP PARSE in gsc, because gsc's parser only
/// recognized <c>+=</c>/<c>-=</c> on a member-access LHS (any other compound
/// operator on <c>obj.Field</c> reported <c>GS0005</c>). Now that gsc accepts
/// any compound operator on a member-access LHS (issue #2154's gsc-side fix),
/// cs2gs's existing pass-through translation for compound-assignment
/// expressions on a member with a user-defined operator overload round-trips
/// cleanly with no code changes needed on the cs2gs side — this is a
/// regression test proving that end-to-end.
/// </summary>
public class Issue2154CompoundOperatorTranslationTests
{
    [Theory]
    [InlineData("*=")]
    [InlineData("/=")]
    [InlineData("%=")]
    public void MemberAccessCompoundAssignment_WithUserOperatorOverload_TranslatesAndRoundTrips(
        string compoundToken)
    {
        string source = $@"
using System;
namespace Demo
{{
    public struct Vec
    {{
        public int X;

        public static Vec operator *(Vec a, int s) => new Vec {{ X = a.X * s }};
        public static Vec operator /(Vec a, int s) => new Vec {{ X = a.X / s }};
        public static Vec operator %(Vec a, int s) => new Vec {{ X = a.X % s }};
    }}

    public class Holder
    {{
        public Vec V;
    }}

    public class C
    {{
        public void M()
        {{
            var h = new Holder();
            h.V {compoundToken} 3;
            Console.WriteLine(h.V.X);
        }}
    }}
}}
";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);

        Assert.Contains($"h.V {compoundToken} 3", printed);

        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated compound-assignment member access must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
    }
}
