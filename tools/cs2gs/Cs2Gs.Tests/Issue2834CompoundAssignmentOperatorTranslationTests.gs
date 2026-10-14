// <copyright file="Issue2834CompoundAssignmentOperatorTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #2834 — a C# 14 user-defined compound-assignment operator
/// (`public void operator +=(int amount)`) used to be reported as a loud
/// CS2GS-GAP because G# had no way to declare one. It now translates to the
/// canonical G# IN-BODY member `public func operator +=(amount int32)`,
/// which emits the same instance, `void`-returning, `specialname`
/// `op_*Assignment` method Roslyn produces.
///
/// Crucially it is NOT lifted to a top-level receiver-clause sibling the way a
/// binary operator is: the receiver-clause rewrite makes binary operators
/// `static`, which is exactly the wrong shape here.
open class Issue2834CompoundAssignmentOperatorTranslationTests {
    @Fact
    func CompoundAssignmentOperator_TranslatesAsInBodyMember_NotLiftedToTopLevel() {
        let unit = Translate(Source)
        let bag = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "TallyBag")
        let op = bag.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "operator +=")
        Assert.Null(op.Receiver)
        Assert.Null(op.ReturnType)
        Assert.Single(op.Parameters)
        Assert.Equal("amount", op.Parameters[0].Name)
        // Nothing was lifted to the compilation unit.
        Assert.DoesNotContain(
            unit.Members.OfType[MethodDeclaration](),
            (m MethodDeclaration) -> m.Name.StartsWith("operator ", StringComparison.Ordinal)
        )
    }

    @Fact
    func CompoundAssignmentOperator_IsNotReportedAsAnUnsupportedGap() {
        let project = Load(Source)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("operator +=", StringComparison.Ordinal) &&
                d.Severity == TranslationSeverity.Unsupported
        )
    }

    @Fact
    func CompoundAssignmentOperator_RendersCanonicalGSharp() {
        let rendered = GSharpPrinter.Print(Translate(Source))
        Assert.Contains("func operator +=(amount int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("func operator -=(amount int32)", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ExpressionBodiedCompoundAssignmentOperator_StaysExpressionBodied() {
        // `public void operator -=(int amount) => _total = _total - amount;`
        // remains a direct G# assignment body.
        let unit = Translate(Source)
        let bag = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "TallyBag")
        let op = bag.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "operator -=")
        Assert.Null(op.Receiver)
        Assert.Null(op.ReturnType)
        Assert.Null(op.Body)
        Assert.NotNull(op.ExpressionBody)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("func operator -=(amount int32) ->", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func BinaryOperator_IsStillLiftedToTopLevelReceiverClauseForm() {
        // Regression guard: the compound-assignment carve-out must not disturb
        // the binary-operator path, which stays a top-level receiver-clause
        // declaration (ADR-0035 / issue #2377).
        const binarySource = `
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
`
        let unit = Translate(binarySource)
        let meters = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Meters")
        Assert.DoesNotContain(
            meters.Members.OfType[MethodDeclaration](),
            (m MethodDeclaration) -> m.Name == "operator +"
        )
        let lifted = unit.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "operator +")
        Assert.NotNull(lifted.Receiver)
        Assert.NotNull(lifted.ReturnType)
    }

    shared {
        private const Source string = `
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
`

        private func Load(source string) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Compound.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            return project
        }

        private func Translate(source string) CompilationUnit {
            let project = Load(source)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return CSharpToGSharpTranslator().TranslateDocument(document, context)
        }
    }
}
