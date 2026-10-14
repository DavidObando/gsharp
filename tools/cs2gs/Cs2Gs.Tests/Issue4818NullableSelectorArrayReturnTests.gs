// <copyright file="Issue4818NullableSelectorArrayReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

class Issue4818NullableSelectorArrayReturnTests {
    @Fact
    func NullableSelectorMaterializedAsReturnedArray_PreservesNullElement() {
        const source = `#nullable disable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

public static class Extensions
{
    public static object[] Ignore<T>(this IEnumerable<T> values) =>
        new[] { new object() };
}

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

    public static object[] Ignored() =>
        new[] { typeof(string) }
            .Select(type => type.FullName)
            .Ignore();

    public static object[] CastSelectorValues()
    {
        var arguments = new[]
        {
            new CustomAttributeTypedArgument(typeof(string), null),
        };
        return arguments
            .Select((Func<CustomAttributeTypedArgument, object>)(
                argument => argument.Value))
            .ToArray();
    }

    public static object[] CastBranchValues()
    {
        var arguments = new[]
        {
            new CustomAttributeTypedArgument(typeof(string), null),
        };
        return arguments
            .Select(argument => argument.Value is Type
                ? new object()
                : (object)argument.Value)
            .ToArray();
    }

    public static object[] StaticValues()
    {
        var arguments = new[]
        {
            new CustomAttributeTypedArgument(typeof(string), null),
        };
        return Enumerable.ToArray(
            arguments.Select(argument => argument.Value));
    }

    public static object[] CastSequenceValues()
    {
        var arguments = new[]
        {
            new CustomAttributeTypedArgument(typeof(string), null),
        };
        return ((IEnumerable<object>)arguments
                .Select(argument => argument.Value))
            .ToArray();
    }

}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let signature = printed.IndexOf("func Values", StringComparison.Ordinal)
        Assert.True(signature >= 0, printed)
        Assert.True(
            printed.Substring(signature, Math.Min(80, printed.Length - signature)).StartsWith(
                "func Values() []object?",
                StringComparison.Ordinal
            ),
            printed.Substring(signature, Math.Min(300, printed.Length - signature))
        )
        Assert.DoesNotContain("argument.Value!!", printed, StringComparison.Ordinal)
        Assert.Contains("func Names() []string", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Names() []string?", printed, StringComparison.Ordinal)
        Assert.Contains("func Reprojected() []object", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Reprojected() []object?", printed, StringComparison.Ordinal)
        Assert.Contains("func Ignored() []object", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Ignored() []object?", printed, StringComparison.Ordinal)
        Assert.Contains("func CastSelectorValues() []object?", printed, StringComparison.Ordinal)
        Assert.Contains("func CastBranchValues() []object?", printed, StringComparison.Ordinal)
        Assert.Contains("func StaticValues() []object?", printed, StringComparison.Ordinal)
        Assert.Contains("func CastSequenceValues() []object?", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(\"$${Probe.Values()[0] == nil}|$${Probe.Names()[0]}|$${Probe.CastSelectorValues()[0] == nil}|$${Probe.CastBranchValues()[0] == nil}|$${Probe.StaticValues()[0] == nil}|$${Probe.CastSequenceValues()[0] == nil}\")",
            "True|String|True|True|True|True"
        )
    }

    @Fact
    func WrappedGenericSelectorResult_DoesNotWidenReturnedArray() {
        const source = `#nullable disable
using System;
using System.Collections.Generic;
using System.Linq;

public static class Extensions
{
    public static IEnumerable<TResult[]> Wrap<T, TResult>(
        this IEnumerable<T> values,
        Func<T, TResult> selector) =>
        values.Select(value => new[] { selector(value) });
}

public static class Probe
{
    public static object[] Wrapped() =>
        new[] { typeof(string) }
            .Wrap(type => type.FullName)
            .ToArray();
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("func Wrapped() []object", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Wrapped() []object?", printed, StringComparison.Ordinal)
    }

    @Fact
    func InterfaceImplementation_DoesNotRepaintFixedArrayContract() {
        const source = `#nullable disable
using System.Linq;
using System.Reflection;

public interface IProbe
{
    object[] Values();
}

public sealed class Probe : IProbe
{
    public object[] Values()
    {
        var arguments = new[]
        {
            new CustomAttributeTypedArgument(typeof(string), null),
        };
        return arguments
            .Select(argument => argument.Value)
            .ToArray();
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Equal(2, printed.Split("func Values() []object", StringSplitOptions.None).Length - 1)
        Assert.DoesNotContain("func Values() []object?", printed, StringComparison.Ordinal)
    }
}
