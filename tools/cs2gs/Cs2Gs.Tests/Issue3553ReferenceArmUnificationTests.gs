// <copyright file="Issue3553ReferenceArmUnificationTests.cs" company="GSharp">
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

/// Issue #3553: C# target-types every switch-expression arm and conditional
/// branch to the common/converted type, while gsc requires arms to share a
/// type outright (GS0179/GS0263). Reference arms whose own type differs from
/// the converted type by more than a nullable annotation now spell the upcast
/// (`arm as T`), mirroring the #3543 numeric widening.
open class Issue3553ReferenceArmUnificationTests {
    @Fact
    func SwitchExpression_ReferenceArms_UpcastToConvertedType() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public class Node
    {
        public List<Node> Children { get; } = new();
    }

    public static class Probe
    {
        public static IEnumerable<Node> Expand(object value)
        {
            IEnumerable<Node> results = value switch
            {
                Node node => new[] { node },
                List<Node> list => list.Where(n => n != null),
                _ => Enumerable.Empty<Node>(),
            };

            return results;
        }
    }
}`)
        // The slice arm and the Where arm both upcast; the already-exact
        // Enumerable.Empty arm stays bare.
        Assert.Contains("cast[IEnumerable[Node]](", printed)
    }

    @Fact
    func Conditional_ReferenceBranches_UpcastToCommonType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Animal { }
    public class Dog : Animal { }
    public class Cat : Animal { }

    public static class Probe
    {
        public static Animal Pick(bool wantDog)
        {
            return wantDog ? new Dog() : new Cat();
        }
    }
}`)
        Assert.Contains("cast[Animal](", printed)
    }

    @Fact
    func UniformReferenceArms_StayBare() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Probe
    {
        public static string Pick(int value)
        {
            return value switch
            {
                0 => "zero",
                _ => "many",
            };
        }
    }
}`)
        Assert.DoesNotContain(" as string", printed)
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
