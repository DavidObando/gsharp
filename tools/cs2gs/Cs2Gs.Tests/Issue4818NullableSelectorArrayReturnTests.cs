// <copyright file="Issue4818NullableSelectorArrayReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4818NullableSelectorArrayReturnTests
{
    [Fact]
    public void NullableSelectorMaterializedAsReturnedArray_PreservesNullElement()
    {
        const string source = """
            #nullable disable
            using System;
            using System.Linq;
            using System.Reflection;

            public static class Probe
            {
                public static object[] Values()
                {
                    var arguments = new[]
                    {
                        new CustomAttributeTypedArgument(typeof(string), null),
                    };
                    return arguments
                        .Select(argument => argument.Value is Type type
                            ? (object)(type.FullName ?? type.Name)
                            : argument.Value)
                        .ToArray();
                }

                public static string[] Names() =>
                    new[] { typeof(string) }
                        .Select(type => type.Name)
                        .ToArray();

                public static object[] Reprojected() =>
                    new[] { typeof(string) }
                        .Select(type => type.FullName)
                        .Select(_ => new object())
                        .ToArray();
            }
            """;
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Probe.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        int signature = printed.IndexOf("func Values", StringComparison.Ordinal);
        Assert.True(signature >= 0, printed);
        Assert.True(
            printed.Substring(signature, Math.Min(80, printed.Length - signature))
                .StartsWith("func Values() []object?", StringComparison.Ordinal),
            printed.Substring(signature, Math.Min(300, printed.Length - signature)));
        Assert.DoesNotContain("argument.Value!!", printed, StringComparison.Ordinal);
        Assert.Contains("func Names() []string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func Names() []string?", printed, StringComparison.Ordinal);
        Assert.Contains("func Reprojected() []object", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func Reprojected() []object?", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(\"${Probe.Values()[0] == nil}|${Probe.Names()[0]}\")",
            "True|String");
    }
}
