// <copyright file="Issue4832SwitchArmValueConversionTests.cs" company="GSharp">
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

/// Issue #4832: switch arms retain C#'s implicit value-type conversion to the
/// switch result type so gsc does not reject otherwise compatible arms.
open class Issue4832SwitchArmValueConversionTests {
    @Fact
    func SwitchExpression_ValueArm_ConvertsToResultType() {
        let printed = TranslateUnit(`
using System.Reflection.Metadata;

namespace Demo
{
    public static class Probe
    {
        public static EntityHandle Owner(MetadataReader metadata, EntityHandle constructor)
        {
            return constructor.Kind switch
            {
                HandleKind.MemberReference => metadata.GetMemberReference((MemberReferenceHandle)constructor).Parent,
                HandleKind.MethodDefinition => metadata.GetMethodDefinition((MethodDefinitionHandle)constructor).GetDeclaringType(),
                _ => default,
            };
        }
    }
}`)
        Assert.Contains(
            "EntityHandle(metadata.GetMethodDefinition(MethodDefinitionHandle(constructor)).GetDeclaringType())",
            printed,
            StringComparison.Ordinal
        )
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
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }
    }
}
