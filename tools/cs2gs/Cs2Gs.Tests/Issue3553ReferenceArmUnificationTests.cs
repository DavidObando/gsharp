// <copyright file="Issue3553ReferenceArmUnificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3553: C# target-types every switch-expression arm and conditional
/// branch to the common/converted type, while gsc requires arms to share a
/// type outright (GS0179/GS0263). Reference arms whose own type differs from
/// the converted type by more than a nullable annotation now spell the upcast
/// (`arm as T`), mirroring the #3543 numeric widening.
/// </summary>
public class Issue3553ReferenceArmUnificationTests
{
    [Fact]
    public void SwitchExpression_ReferenceArms_UpcastToConvertedType()
    {
        string printed = TranslateUnit(@"
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
}");

        // The slice arm and the Where arm both upcast; the already-exact
        // Enumerable.Empty arm stays bare.
        Assert.Contains("cast[IEnumerable[Node]](", printed);
    }

    [Fact]
    public void Conditional_ReferenceBranches_UpcastToCommonType()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("Animal(", printed);
    }

    [Fact]
    public void UniformReferenceArms_StayBare()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Probe
    {
        public static string Pick(int value)
        {
            return value switch
            {
                0 => ""zero"",
                _ => ""many"",
            };
        }
    }
}");

        Assert.DoesNotContain(" as string", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
