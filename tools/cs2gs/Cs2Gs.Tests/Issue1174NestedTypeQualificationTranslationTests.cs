// <copyright file="Issue1174NestedTypeQualificationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1174 / #914: when a C# source nested type shares its simple name with a
/// same-named top-level type, the translator must emit the nested type in its
/// qualified <c>Container.Nested</c> form so the generated G# binds against the
/// NESTED type (not the top-level homonym holding the simple key). This mirrors
/// the cs2gs SttsBox.SampleEntry migration shape. A non-colliding source nested
/// type is still emitted by its simple name (no gratuitous qualification).
/// </summary>
public class Issue1174NestedTypeQualificationTranslationTests
{
    private const string CollisionSource = @"
namespace Corpus
{
    public class SampleEntry
    {
        public int A;
    }

    public class SttsBox
    {
        public struct SampleEntry
        {
            public uint FrameCount;
            public uint FrameDelta;
        }

        public SampleEntry Make()
        {
            return new SampleEntry { FrameCount = 1, FrameDelta = 2 };
        }
    }
}
";

    private const string NoCollisionSource = @"
namespace Corpus
{
    public class SttsBox
    {
        public struct Entry
        {
            public uint FrameCount;
        }

        public Entry Make()
        {
            return new Entry { FrameCount = 1 };
        }
    }
}
";

    [Fact]
    public void Collision_NestedType_IsEmittedQualified_AndBinds()
    {
        string printed = Translate(CollisionSource);

        // The nested type is qualified at both the return-type clause and the
        // construction site, so it no longer binds to the top-level homonym.
        Assert.Contains("SttsBox.SampleEntry", printed);

        // The emitted G# parses cleanly...
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));

        // ...and fully binds with no member-resolution error (GS0158) — proving
        // the qualified reference resolves against the nested type.
        var diagnostics = BindDiagnostics(printed);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    [Fact]
    public void NoCollision_NestedType_IsEmittedBySimpleName()
    {
        string printed = Translate(NoCollisionSource);

        // Without a homonym the nested type keeps its simple name (no gratuitous
        // qualification) and still binds.
        Assert.DoesNotContain("SttsBox.Entry", printed);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));

        var diagnostics = BindDiagnostics(printed);
        Assert.DoesNotContain(diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# source should bind with no errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> BindDiagnostics(string gsharpSource)
    {
        var tree = SyntaxTree.Parse(SourceText.From(gsharpSource));
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return scope.Diagnostics;
    }
}
