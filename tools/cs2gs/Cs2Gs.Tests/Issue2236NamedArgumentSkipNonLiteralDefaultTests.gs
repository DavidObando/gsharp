// <copyright file="Issue2236NamedArgumentSkipNonLiteralDefaultTests.cs" company="GSharp">
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

/// Issue #2236/#3090: optional declarations retain their defaults and named
/// call sites retain names. Native gsc binding supplies skipped defaults.
open class Issue2236NamedArgumentSkipNonLiteralDefaultTests {
    @Fact
    func NamedArgument_SkipsParameterWithDecimalDefault_PreservesNames() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a, decimal price = 1.5m, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}`, "G# currently cannot bind decimal optional defaults emitted without a decimal literal suffix.")
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal)
    }

    @Fact
    func DecimalDefault_WithoutNamedArguments_KeepsParameterOptional() {
        // Regression for the same root cause on the DECLARATION side (not just
        // the named-argument-skip path): a plain `decimal` default must not be
        // silently dropped, or the parameter becomes wrongly required.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a, decimal price = 1.5m) { }

        public void Caller()
        {
            Foo(1);
        }
    }
}`, "G# currently cannot bind decimal optional defaults emitted without a decimal literal suffix.")
        Assert.Contains("price decimal = 1.5", printed, StringComparison.Ordinal)
        Assert.Contains("Foo(1)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NamedArgument_SkipsParameterWithDefaultKeyword_PreservesNames() {
        let printed = TranslateUnit(`
namespace Demo
{
    public struct Options { public int X; }

    public class C
    {
        public void Foo(int a, Options table = default, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}`)
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NamedArgument_SkipsParameterWithNewValueTypeDefault_PreservesNames() {
        let printed = TranslateUnit(`
namespace Demo
{
    public struct Options { public int X; }

    public class C
    {
        public void Foo(int a, Options table = new Options(), int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}`)
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NamedArgument_SkipsParameterWithReferencedConstantDefault_PreservesNames() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public const string TableName = "users";

        public void Foo(int a, string table = TableName, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}`)
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NamedArgument_SkipsParameterWithSimpleLiteralDefault_StillWorks() {
        // Baseline from issue #1727: must still work unchanged.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b = 42, int flag = 0) { }

        public void Caller()
        {
            Foo(a: 1, flag: 2);
        }
    }
}`)
        Assert.Contains("Foo(a: 1, flag: 2)", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateUnit(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
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
