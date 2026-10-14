// <copyright file="Issue1281RedundantNumericArgumentWrapTests.cs" company="GSharp">
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

/// Issue #1281: gsc now applies, at a concrete numeric parameter, the same
/// implicit lossless widening (ADR-0044) and constant-expression narrowing
/// (C# §10.2.11) that C# performs at the call site. The translator must
/// therefore stop emitting the redundant explicit `T(x)` conversion that
/// gsc accepts on its own, while still keeping it where gsc cannot reproduce the
/// conversion: a generic (type-parameter) target, or a non-literal constant that
/// gsc does not fold (e.g. a `const` field).
open class Issue1281RedundantNumericArgumentWrapTests {
    /// A widening conversion of a non-constant operand to a concrete numeric
    /// parameter (`ushort` → `int`) is dropped: gsc widens the operand
    /// implicitly at the call site, so the explicit `int32(u)` is redundant.
    @Fact
    func Argument_WideningNonConstantToConcreteParameter_SkipsExplicitConversion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void M(int x) { }

        public void Caller(ushort u)
        {
            M(u);
        }
    }
}`)
        Assert.Contains("M(u)", printed)
        Assert.DoesNotContain("int32(u)", printed)
    }

    /// A constant-expression cross-sign conversion of an integer LITERAL to a
    /// concrete unsigned parameter (`5` → `uint`) is dropped: gsc folds
    /// the literal and accepts it because the value is in range, so the explicit
    /// `uint32(5)` is redundant.
    @Fact
    func Argument_ConstantLiteralCrossSignToConcreteParameter_SkipsExplicitConversion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void M(uint x) { }

        public void Caller()
        {
            M(5);
        }
    }
}`)
        Assert.Contains("M(5)", printed)
        Assert.DoesNotContain("uint32(", printed)
    }

    /// A widening conversion of an integer LITERAL to a concrete wider parameter
    /// (`5` → `long`) is dropped: gsc widens the literal implicitly.
    @Fact
    func Argument_WideningLiteralToConcreteParameter_SkipsExplicitConversion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void M(long x) { }

        public void Caller()
        {
            M(5);
        }
    }
}`)
        Assert.Contains("M(5)", printed)
        Assert.DoesNotContain("int64(", printed)
    }

    /// A constant-expression cross-sign conversion of a `const` FIELD (not a
    /// bare literal) to a concrete unsigned parameter keeps its explicit
    /// `uint32(Five)`: gsc only folds literals and unary +/- over literals at
    /// the call site (ADR-0129), so a const-field reference is not value-known to
    /// gsc and the conversion must remain explicit.
    @Fact
    func Argument_ConstantFieldCrossSignToConcreteParameter_KeepsExplicitConversion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private const int Five = 5;

        public void M(uint x) { }

        public void Caller()
        {
            M(Five);
        }
    }
}`)
        Assert.Contains("uint32(Five)", printed)
    }

    /// A widening conversion to a GENERIC (type-parameter) parameter keeps its
    /// explicit conversion: gsc's CLR generic inference does not unify a
    /// widening-only numeric argument (GS0159), so the operand must already carry
    /// the converted type.
    @Fact
    func Argument_WideningToGenericParameter_KeepsExplicitConversion() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public void M(int x)
        {
            ArgumentOutOfRangeException.ThrowIfGreaterThan(x, ushort.MaxValue);
        }
    }
}`)
        Assert.Contains("int32(uint16.MaxValue)", printed)
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
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
