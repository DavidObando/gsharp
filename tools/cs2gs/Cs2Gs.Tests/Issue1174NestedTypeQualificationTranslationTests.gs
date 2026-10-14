// <copyright file="Issue1174NestedTypeQualificationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1174 / #914: when a C# source nested type shares its simple name with a
/// same-named top-level type, the translator must emit the nested type in its
/// qualified `Container.Nested` form so the generated G# binds against the
/// NESTED type (not the top-level homonym holding the simple key). This mirrors
/// the cs2gs SttsBox.SampleEntry migration shape. A non-colliding source nested
/// type is emitted by its simple name only inside its containing type.
open class Issue1174NestedTypeQualificationTranslationTests {
    @Fact
    func Collision_NestedType_IsEmittedQualified_AndBinds() {
        let printed = Translate(CollisionSource)
        // The nested type is qualified at both the return-type clause and the
        // construction site, so it no longer binds to the top-level homonym.
        Assert.Contains("SttsBox.SampleEntry", printed)
        // The emitted G# parses cleanly...
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
        // ...and fully binds with no member-resolution error (GS0158) — proving
        // the qualified reference resolves against the nested type.
        let diagnostics = BindDiagnostics(printed)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func NoCollision_NestedType_IsEmittedBySimpleName() {
        let printed = Translate(NoCollisionSource)
        // Without a homonym the nested type keeps its simple name (no gratuitous
        // qualification) and still binds.
        Assert.DoesNotContain("SttsBox.Entry", printed)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
        let diagnostics = BindDiagnostics(printed)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func NoCollision_NestedTypeReferencedExternally_IsQualified() {
        let printed = Translate(ExternalReferenceSource)
        Assert.Contains("class Reader : Host.IReader", printed)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
        let diagnostics = BindDiagnostics(printed)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    shared {
        private const CollisionSource string = `
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
`

        private const NoCollisionSource string = `
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
`

        private const ExternalReferenceSource string = `
namespace Corpus
{
    public class Host
    {
        public interface IReader
        {
        }
    }

    public class Reader : Host.IReader
    {
    }
}
`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Program.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Inline C# source should bind with no errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func BindDiagnostics(gsharpSource string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(gsharpSource))
            let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return scope_.Diagnostics
        }
    }
}
