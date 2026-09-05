// <copyright file="Issue3920Gsa0002ImportedOperandDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using Cs2Gs.Translator.Analyzers;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 M5, issue #3920: a Roslyn <c>OperationKind</c> corresponds to
/// SEVERAL G# bound-node kinds, and the one GSA0002 exists to police is never
/// the one the naive one-to-one map named.
///
/// <para>
/// G# binds <c>a == b</c> over operands of an IMPORTED CLR type to
/// <c>BoundClrBinaryOperatorExpression</c> (the resolved <c>op_Equality</c>),
/// not to <c>BoundBinaryExpression</c>; and a call to an imported method such
/// as <c>object.ReferenceEquals</c> to <c>BoundImportedCallExpression</c>, not
/// to <c>BoundCallExpression</c>. Translating
/// <c>RegisterOperationAction(h, OperationKind.BinaryOperator)</c> to a single
/// <c>RegisterBoundNodeAction(h, BoundNodeKind.BinaryExpression)</c> therefore
/// dispatched the migrated GSA0002 zero times over reflection-<c>Type</c>
/// comparisons — which are imported by construction — and the rule reported
/// nothing at all.
/// </para>
///
/// <para>
/// Every assertion here EXECUTES: the real analyzer is translated, compiled by
/// the real G# compiler, loaded, and run through the real
/// <see cref="GSharpAnalyzerVerifier"/> over the translated snippet. The
/// positive and the two negatives share one path, so a rule that stops
/// reporting fails the positive rather than passing the negatives quietly.
/// </para>
/// </summary>
public sealed class Issue3920Gsa0002ImportedOperandDispatchTests : IDisposable
{
    // The real positive snippet from
    // ReflectionTypeComparisonAnalyzerTests.ReportsTypeofReferenceComparisonsInCompilerMetadataNamespaces.
    // All three sites compare an imported System.Type, so all three bind to
    // the imported-operand node shapes.
    private const string Gsa0002Positive = """
using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    class C
    {
        bool EqualsTypeof(Type type) => [|type == typeof(string)|];
        bool NotEqualsTypeof(Type type) => [|typeof(int) != type|];
        bool ReferenceEqualsTypeof(Type type) => [|ReferenceEquals(type, typeof(string))|];
    }
}
""";

    // The real negative snippet from the same class: symbol comparisons, Type
    // compared to Type (no typeof), null checks, and the two exempt utility
    // types. Every one of these now REACHES the handler — before #3920 it was
    // silent because nothing was dispatched at all.
    private const string Gsa0002NegativeExemptions = """
using System;

namespace GSharp.Core.CodeAnalysis.Symbols
{
    class Symbol { }
    class C
    {
        bool Same(Symbol a, Symbol b) => ReferenceEquals(a, b) || a == b;
        bool SameTypes(Type a, Type b) => ReferenceEquals(a, b) || a == b || a != b;
        bool NullCheck(Type a) => a == null || null != a;
    }

    class ClrTypeUtilities
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }

    class TypeIdentityComparer
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }
}
""";

    // The real negative snippet whose only exemption is the namespace.
    private const string Gsa0002NegativeNamespace = """
using System;

namespace GSharp.Core.CodeAnalysis.Syntax
{
    class C
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(string);
    }
}
""";

    private readonly DirectoryInfo workDirectory =
        Directory.CreateTempSubdirectory("cs2gs-gsa0002-dispatch");

    /// <summary>Gets the GSA0002 positive and negative cases.</summary>
    /// <returns>The theory data.</returns>
    public static IEnumerable<object[]> Gsa0002Cases()
    {
        yield return new object[]
        {
            Gsa0002Positive,
            new[] { "GSA0002", "GSA0002", "GSA0002" },
        };
        yield return new object[] { Gsa0002NegativeExemptions, Array.Empty<string>() };
        yield return new object[] { Gsa0002NegativeNamespace, Array.Empty<string>() };
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        try
        {
            workDirectory.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>
    /// GSA0002, end to end, positive AND negatives on one path: the translated
    /// rule reports at exactly the three re-placed markers of the positive
    /// snippet — the case that reported NOTHING before the one-to-many kind
    /// expansion — and stays silent over both negatives.
    /// </summary>
    /// <param name="markedSnippet">The C# snippet with its markers.</param>
    /// <param name="ids">The expected diagnostic ids.</param>
    [Theory]
    [MemberData(nameof(Gsa0002Cases))]
    public void TranslatedGsa0002_AgreesWithTheCSharpExpectation(string markedSnippet, string[] ids)
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(markedSnippet);
        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);

        string analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer(
            workDirectory.FullName, "ReflectionTypeComparisonAnalyzer.cs", "TranslatedGsa0002");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, result.GsWithMarkers, ids);
    }
}
