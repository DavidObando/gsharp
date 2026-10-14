// <copyright file="Issue3501YieldBreakTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis

// Issue #3501 Track A1: C# `yield break` now translates to G#'s native
// `yield break` statement instead of a synthesized `goto __iteratorExit`
// plus a trailing label.
class Issue3501YieldBreakTranslationTests {
    @Fact
    func YieldBreak_TranslatesNativelyAndRuns() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    public static IEnumerable<int> Items(int limit)
    {
        foreach (var i in new[] { 1, 2, 3, 4 })
        {
            if (i > limit)
            {
                yield break;
            }

            yield return i;
        }

        yield return 99;
    }

    public static int Run()
    {
        int total = 0;
        foreach (var v in Items(2))
        {
            total += v;
        }

        return total;
    }
}`)
        Assert.Contains("yield break", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__iteratorExit", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("goto", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    shared {
        private func Translate(source string, additionalReferences ...MetadataReference) string {
            let references IReadOnlyList[MetadataReference]? = if additionalReferences.Length == 0 {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy((reference MetadataReference) -> reference.Display!!, StringComparer.Ordinal)
                    .Select((group IGrouping[string, MetadataReference]) -> group.First())
                    .ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
