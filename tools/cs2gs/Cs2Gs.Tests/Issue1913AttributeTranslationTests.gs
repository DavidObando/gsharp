// <copyright file="Issue1913AttributeTranslationTests.cs" company="GSharp">
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

/// Regression tests for issue #1913: a PARAMETER attribute (e.g. `[Note] int
/// x`) was silently dropped from the translated G#, because
/// `MapParameter` never routed its `ParameterSyntax` through the
/// shared `MapAttributes` helper every other declaration kind (class,
/// method, property, field, ...) already calls — with no diagnostic to flag
/// the loss. Separately, a C# 11 generic attribute (`[Tag<int>]`)
/// emitted its type argument in angle brackets (`@Tag<int>`), which
/// G# cannot parse (GS0005 LessToken) since G# spells every generic
/// type-argument list in square brackets.
open class Issue1913AttributeTranslationTests {
    @Fact
    func ParameterAttribute_SimpleAttribute_IsNotDropped() {
        let printed = TranslateUnit(`
using System;

[AttributeUsage(AttributeTargets.Parameter)]
public class NoteAttribute : Attribute
{
}

namespace Demo
{
    public class C
    {
        public void M([Note] int x)
        {
        }
    }
}`)
        Assert.Contains("@Note", printed)
        Assert.Contains("@Note x int32", printed)
    }

    @Fact
    func GenericAttribute_TypeArgument_UsesSquareBrackets() {
        let printed = TranslateUnit(`
using System;

[AttributeUsage(AttributeTargets.Class)]
public class TagAttribute<T> : Attribute
{
}

namespace Demo
{
    [Tag<int>]
    public class C
    {
    }
}`)
        Assert.Contains("@Tag[int32]", printed)
        Assert.DoesNotContain("<int>", printed)
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
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
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
