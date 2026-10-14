// <copyright file="Issue3418PatternGuardBranchTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3418: legacy pattern-guard hoists must preserve each else-if branch
/// exactly once.
class Issue3418PatternGuardBranchTranslationTests {
    @Fact
    func MutableValuePatternGuard_PreservesElseIfWhenTypeTestFails() {
        let printed = Translate(`namespace Demo
{
    public static class C
    {
        private static bool TryRead(int value, out int extra)
        {
            extra = 2;
            return value > 0;
        }

        public static int Select(object value)
        {
            if (value is int number && TryRead(number, out var extra))
            {
                number += 1;
                return number + extra;
            }
            else if (value is string)
            {
                return 20;
            }
            else
            {
                throw new System.InvalidOperationException();
            }
        }
    }
}`)
        Assert.Equal(1, CountOccurrences(printed, "return 20"))
        Assert.Equal(1, CountOccurrences(printed, "throw InvalidOperationException()"))
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C.Select(\"text\"))\nConsole.WriteLine(C.Select(42))",
            "20" + Environment.NewLine + "45"
        )
    }

    @Fact
    func PositionalIfLetGuard_EmitsElseIfBranchOnce() {
        let printed = Translate(`namespace Demo
{
    public sealed class Node
    {
        public Node(int value)
        {
            Value = value;
        }

        public int Value;

        public void Deconstruct(out int value)
        {
            value = Value;
        }
    }

    public static class C
    {
        private static object Get(object value) => value;

        public static int Select(object value)
        {
            if (value != null && Get(value) is Node(1) node && node.Value > 0)
            {
                return 10;
            }
            else if (value is string)
            {
                return 20;
            }
            else
            {
                throw new System.InvalidOperationException();
            }
        }
    }
}`, allowPositionalPatternDiagnostic: true)
        Assert.Equal(1, CountOccurrences(printed, "return 20"))
        Assert.Equal(1, CountOccurrences(printed, "throw InvalidOperationException()"))
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C.Select(\"text\"))", "20")
    }

    @Fact
    func PatternGuardHoists_WithFilteredCatch_DoNotReportControlFlowMismatch() {
        let printed = Translate(`namespace Demo
{
    public static class C
    {
        public static int Select(object value, bool useFilter)
        {
            if (value is int number && number > 0)
            {
                number += 1;
                return number;
            }
            else if (value is string text && text.Length > 0)
            {
                text += "!";
                return text.Length;
            }
            else
            {
            }

            try
            {
                throw new System.InvalidOperationException();
            }
            catch (System.InvalidOperationException) when (useFilter)
            {
                return 30;
            }
            catch (System.Exception)
            {
                return 40;
            }
        }
    }
}`)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, `Console.WriteLine(C.Select(2, false))
Console.WriteLine(C.Select("text", false))
Console.WriteLine(C.Select(Object(), true))
Console.WriteLine(C.Select(Object(), false))`, string.Join(Environment.NewLine, "3", "5", "30", "40"))
    }

    shared {
        private func Translate(source string, allowPositionalPatternDiagnostic bool = false) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            if allowPositionalPatternDiagnostic {
                Assert.All(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> Assert.True(
                        diagnostic.Severity == TranslationSeverity.Info || diagnostic.ConstructKind == "Subpattern",
                        diagnostic.ToString()
                    )
                )
            } else {
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
                )
            }
            TranslationTestValidation.AssertBinds(printed)
            return printed
        }

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var index = 0
            while (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += value.Length
            }
            return count
        }
    }
}
