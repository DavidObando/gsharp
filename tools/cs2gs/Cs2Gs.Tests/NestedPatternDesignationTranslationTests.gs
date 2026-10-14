// <copyright file="NestedPatternDesignationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// A designation on a NESTED untyped property pattern
/// (`{ ClrType: { IsGenericType: true } closedClr }`) must survive
/// translation as G#'s native ADR-0166 after-brace designator. The untyped
/// recursive-pattern branch used to drop `Designation` entirely,
/// orphaning every body reference to the binder (GS0125/GS0159) — the
/// 2026-08-29 selfmig nightly regression on
/// `TupleElementNamesReader.cs` that cascaded migrated
/// `src/Core` compile failures into 18 downstream apps.
open class NestedPatternDesignationTranslationTests {
    @Fact
    func SwitchStatement_NestedPropertyPatternDesignation_Preserved() {
        let printed = Translate(HolderSource + `        public static int Classify(Holder holder)
        {
            switch (holder)
            {
                case { ClrType: { IsGenericType: true, IsGenericTypeDefinition: false } closedClr }:
                    return closedClr.GetGenericArguments().Length;

                default:
                    return -1;
            }
        }

        public static int Run()
        {
            var generic = new Holder { ClrType = typeof(System.Collections.Generic.List<int>) };
            return (Classify(generic) * 10) + Classify(new Holder()) + 1;
        }
    }
}`)
        Assert.Contains(
            "case { ClrType: { IsGenericType: true, IsGenericTypeDefinition: false } closedClr }",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("closedClr.GetGenericArguments().Length", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(Demo.Repro.Run())", "10")
    }

    @Fact
    func IsPattern_NestedPropertyPatternDesignation_Preserved() {
        let printed = Translate(HolderSource + `        public static int ViaIs(Holder holder)
        {
            if (holder is { ClrType: { IsGenericType: true } closedClr })
            {
                return closedClr.GetGenericArguments().Length;
            }

            return -1;
        }
    }
}`)
        Assert.Contains("is { ClrType: { IsGenericType: true } closedClr }", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func SwitchExpression_NestedPropertyPatternDesignation_Preserved() {
        let printed = Translate(HolderSource + `        public static int Via(Holder holder) => holder switch
        {
            { ClrType: { IsGenericType: true } closedClr } => closedClr.GetGenericArguments().Length,
            _ => -1,
        };
    }
}`)
        Assert.Contains("case { ClrType: { IsGenericType: true } closedClr }:", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    shared {
        private const HolderSource string = `using System;

namespace Demo
{
    public sealed class Holder
    {
        public Type? ClrType { get; init; }
    }

    public static class Repro
    {`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
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
