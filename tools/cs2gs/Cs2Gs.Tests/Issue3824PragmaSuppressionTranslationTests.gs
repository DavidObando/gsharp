// <copyright file="Issue3824PragmaSuppressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issues #3820 / #3824, ADR-0175: a C# `#pragma warning disable GSA####`
/// region covering a declaration translates to an
/// `@SuppressDiagnostic("GSA####")` annotation on the migrated
/// declaration. Identifier families that name analyzers which do not run on G#
/// (StyleCop `SA`, the C# compiler `CS`, the Roslyn ecosystem
/// `CA`/`IDE`/`VSTHRD`/`RS`) are dropped, not carried.
open class Issue3824PragmaSuppressionTranslationTests {
    @Fact
    func GsaPragmaRegion_BecomesSuppressDiagnosticOnTheCoveredMethod() {
        const source = `
public class Rewriter
{
    public int Untouched() => 1;

#pragma warning disable GSA0005
    public int Suppressed() => 2;
#pragma warning restore GSA0005

    public int AlsoUntouched() => 3;
}
`
        let printed = Translate(source)
        Assert.Contains("@SuppressDiagnostic(\"GSA0005\")", printed, StringComparison.Ordinal)
        // Scoping proof at the translator level: exactly ONE annotation is
        // emitted, on the one method the C# region covered. A file- or
        // project-level bridge would produce zero here and suppress everything.
        Assert.Equal(1, CountOccurrences(printed, "@SuppressDiagnostic"))
        let annotation = printed.IndexOf("@SuppressDiagnostic", StringComparison.Ordinal)
        let suppressed = printed.IndexOf("Suppressed", StringComparison.Ordinal)
        let alsoUntouched = printed.IndexOf("AlsoUntouched", StringComparison.Ordinal)
        Assert.True(annotation < suppressed, "annotation must precede the method it covers")
        Assert.True(suppressed < alsoUntouched, "the following method must be unannotated")
    }

    @Fact
    func MultipleRegions_EachAnnotateTheirOwnMethod() {
        const source = `
public class Rewriter
{
#pragma warning disable GSA0005
    public int First() => 1;
#pragma warning restore GSA0005

    public int Middle() => 2;

#pragma warning disable GSA0005
    public int Second() => 3;
#pragma warning restore GSA0005
}
`
        let printed = Translate(source)
        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GSA0005\")"))
    }

    @Fact
    func NonGsaPragmas_AreDropped() {
        const source = `
public class Sample
{
#pragma warning disable SA1600, CS1591, CA1822, IDE0060, RS2008
    public int Documented() => 1;
#pragma warning restore SA1600, CS1591, CA1822, IDE0060, RS2008
}
`
        let printed = Translate(source)
        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal)
    }

    @Fact
    func MixedRegion_CarriesOnlyTheGsaIdentifier() {
        const source = `
public class Sample
{
#pragma warning disable SA1600, GSA0005, CS1591
    public int Mixed() => 1;
#pragma warning restore SA1600, GSA0005, CS1591
}
`
        let printed = Translate(source)
        Assert.Contains("@SuppressDiagnostic(\"GSA0005\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("SA1600", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("CS1591", printed, StringComparison.Ordinal)
    }

    @Fact
    func FileWideRegion_AnnotatesEveryCoveredMethod() {
        const source = `
#pragma warning disable GSA0005
public class Sample
{
    public int A() => 1;

    public int B() => 2;
}
#pragma warning restore GSA0005
`
        let printed = Translate(source)
        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GSA0005\")"))
    }

    @Fact
    func TranslatedSuppression_BindsInTheMigratedTree() {
        const source = `
public class Rewriter
{
#pragma warning disable GSA0005
    public int Suppressed() => 2;
#pragma warning restore GSA0005
}
`
        let printed = Translate(source)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Program.cs", source)})
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
