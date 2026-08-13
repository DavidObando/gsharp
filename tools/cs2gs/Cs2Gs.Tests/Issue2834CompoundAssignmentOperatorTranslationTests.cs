// <copyright file="Issue2834CompoundAssignmentOperatorTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2834 — a C# 14 user-defined compound-assignment operator
/// (<c>public void operator +=(int amount)</c>) used to be reported as a loud
/// CS2GS-GAP because G# had no way to declare one. It now translates to the
/// canonical G# IN-BODY member <c>public func operator +=(amount int32)</c>,
/// which emits the same instance, <c>void</c>-returning, <c>specialname</c>
/// <c>op_*Assignment</c> method Roslyn produces.
/// <para>
/// Crucially it is NOT lifted to a top-level receiver-clause sibling the way a
/// binary operator is: the receiver-clause rewrite makes binary operators
/// <c>static</c>, which is exactly the wrong shape here.
/// </para>
/// </summary>
public class Issue2834CompoundAssignmentOperatorTranslationTests
{
    private const string Source = @"
namespace Corpus.Compound
{
    public class TallyBag
    {
        private int _total;

        public void operator +=(int amount)
        {
            _total = _total + amount;
        }

        public void operator -=(int amount) => _total = _total - amount;

        public int Total()
        {
            return _total;
        }
    }
}
";

    [Fact]
    public void CompoundAssignmentOperator_TranslatesAsInBodyMember_NotLiftedToTopLevel()
    {
        CompilationUnit unit = Translate(Source);

        TypeDeclaration bag = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "TallyBag");
        MethodDeclaration op = bag.Members.OfType<MethodDeclaration>().Single(m => m.Name == "operator +=");

        Assert.Null(op.Receiver);
        Assert.Null(op.ReturnType);
        Assert.Single(op.Parameters);
        Assert.Equal("amount", op.Parameters[0].Name);

        // Nothing was lifted to the compilation unit.
        Assert.DoesNotContain(
            unit.Members.OfType<MethodDeclaration>(),
            m => m.Name.StartsWith("operator ", StringComparison.Ordinal));
    }

    [Fact]
    public void CompoundAssignmentOperator_IsNotReportedAsAnUnsupportedGap()
    {
        LoadedCSharpProject project = Load(Source);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Message.Contains("operator +=", StringComparison.Ordinal)
                && d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void CompoundAssignmentOperator_RendersCanonicalGSharp()
    {
        string rendered = GSharpPrinter.Print(Translate(Source));

        Assert.Contains("func operator +=(amount int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("func operator -=(amount int32)", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedCompoundAssignmentOperator_StaysExpressionBodied()
    {
        // `public void operator -=(int amount) => _total = _total - amount;`
        // remains a direct G# assignment body.
        CompilationUnit unit = Translate(Source);
        TypeDeclaration bag = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "TallyBag");
        MethodDeclaration op = bag.Members.OfType<MethodDeclaration>().Single(m => m.Name == "operator -=");

        Assert.Null(op.Receiver);
        Assert.Null(op.ReturnType);
        Assert.Null(op.Body);
        Assert.NotNull(op.ExpressionBody);

        string rendered = GSharpPrinter.Print(unit);
        Assert.Contains("func operator -=(amount int32) ->", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void BinaryOperator_IsStillLiftedToTopLevelReceiverClauseForm()
    {
        // Regression guard: the compound-assignment carve-out must not disturb
        // the binary-operator path, which stays a top-level receiver-clause
        // declaration (ADR-0035 / issue #2377).
        const string binarySource = @"
namespace Corpus.Compound
{
    public class Meters
    {
        public double Value;

        public static Meters operator +(Meters a, Meters b)
        {
            return new Meters { Value = a.Value + b.Value };
        }
    }
}
";
        CompilationUnit unit = Translate(binarySource);

        TypeDeclaration meters = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Meters");
        Assert.DoesNotContain(meters.Members.OfType<MethodDeclaration>(), m => m.Name == "operator +");

        MethodDeclaration lifted = unit.Members.OfType<MethodDeclaration>().Single(m => m.Name == "operator +");
        Assert.NotNull(lifted.Receiver);
        Assert.NotNull(lifted.ReturnType);
    }

    private static LoadedCSharpProject Load(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Compound.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        return project;
    }

    private static CompilationUnit Translate(string source)
    {
        LoadedCSharpProject project = Load(source);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }
}
