// <copyright file="Issue4832SwitchArmValueConversionTests.cs" company="GSharp">
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
/// Issue #4832: switch arms retain C#'s implicit value-type conversion to the
/// switch result type so gsc does not reject otherwise compatible arms.
/// </summary>
public class Issue4832SwitchArmValueConversionTests
{
    [Fact]
    public void SwitchExpression_ValueArm_ConvertsToResultType()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains(
            "EntityHandle(metadata.GetMethodDefinition(MethodDefinitionHandle(constructor)).GetDeclaringType())",
            printed,
            StringComparison.Ordinal);
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
            "Translated G# must bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
