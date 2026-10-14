// <copyright file="Issue3468MethodGroupWrapperTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis

// Issue #3468: a method group whose signature already matches the target
// delegate passes through as a direct method reference; a wrapper that IS
// required renders as the concise arrow form with parameter names derived
// from the target method (`(value string) -> Stringify(value)`), keeping
// the block-bodied explicit-return-type function literal only where the
// delegate's result type must be pinned (return covariance) or parameters
// pass by reference.
class Issue3468MethodGroupWrapperTests {
    @Fact
    func MatchingMethodGroups_PassThroughDirect() {
        let printed = Translate(`using System.Collections.Generic;
using System.IO;
using System.Linq;

public class W
{
    public List<string> Full(List<string> paths)
        => paths.Select(Path.GetFullPath).ToList();

    public List<int> Lens(List<string> paths)
        => paths.Select(Len).ToList();

    private static int Len(string s) => s.Length;
}`)
        Assert.Contains("paths.Select(Path.GetFullPath)", printed, StringComparison.Ordinal)
        Assert.Contains("Select(Len)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    // An EXPLICIT C# delegate creation renders as a G# construction,
    // whose operand cannot be a variant group — so the cast shape keeps
    // its arrow wrapper even after #3501 A5.
    @Fact
    func ContravariantCastMethodGroup_KeepsArrowWrapper() {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Linq;

public class W
{
    public List<string> Mixed(List<string> paths)
        => paths.Select((Func<string, string>)Stringify).ToList();

    private static string Stringify(object? value) => value?.ToString() ?? "";
}`)
        Assert.Contains("(value string) -> W.Stringify(value)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func (", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    // Issue #3501 A5: covariant-return groups pass direct.
    @Fact
    func ReturnCovariantMethodGroup_PassesDirect() {
        let printed = Translate(`using System.Collections.Generic;
using System.Linq;

public class W
{
    public List<object> Objs(List<string> paths)
        => paths.Select<string, object>(Twice).ToList();

    private static string Twice(string s) => s + s;
}`)
        Assert.Contains("Select[string, object](Twice)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func (s string) object", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ArrowWrapper_ExecutesWithParity() {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Linq;

public static class Obj
{
    public static int Run()
    {
        var items = new List<string> { "a", "bb" };
        return items.Select((Func<string, int>)Weigh).Sum();
    }

    private static int Weigh(object? value) => (value as string)?.Length ?? 0;
}`)
        Assert.Contains("(value string) -> Obj.Weigh(value)", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ReceiverRootCollision_UsesSourceDerivedSuffix() {
        let printed = Translate(`using System;

public sealed class Renderer
{
    public string Render(object? value)
        => value?.ToString() ?? "";
}

public static class W
{
    public static void Bind(Renderer value)
        => Use((Func<string, string>)value.Render);

    private static void Use(Func<string, string> transform)
    {
    }
}`)
        Assert.Contains(
            "(value_ string) -> Func[string, string](value.Render)(value_)",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func NullableReceiverRootCollision_UsesSourceDerivedSuffix() {
        let printed = Translate(`using System;

public sealed class Renderer
{
    public string Render(object? value)
        => value?.ToString() ?? "";
}

public static class W
{
    public static void Bind(Renderer? value)
        => Use((Func<string, string>)value!.Render);

    private static void Use(Func<string, string> transform)
    {
    }
}`)
        Assert.Contains(
            "(value_ string) -> Func[string, string](value!!.Render)(value_)",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func UnreachableDoubleSuffixCollision_PreservesFutureSourceName() {
        // Issue #4298: preserve the legal future source name `value_`
        // while suffixing the colliding `value`. No current translation
        // path reaches this helper with both collisions, so exercise the
        // defensive corner directly.
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Snippet.cs", "class C { void M(object value, object value_) {} }")}
        )
        let type = Assert.IsAssignableFrom[INamedTypeSymbol](project.Compilation.GetTypeByMetadataName("C"))
        let method = Assert.Single(type.GetMembers("M").OfType[IMethodSymbol]())
        let usedNames = HashSet[string](StringComparer.Ordinal){"value"}
        Assert.Equal("value__", WrapperParameterName(project.Compilation, method.Parameters, 0, usedNames))
        Assert.Equal("value_", WrapperParameterName(project.Compilation, method.Parameters, 1, usedNames))
    }

    @Fact
    func ReservedWrapperParameter_UsesSourceDerivedSuffix() {
        let printed = Translate(`using System;

public static class W
{
    public static void Bind()
        => Use((Func<string, string>)Normalize);

    private static string Normalize(object? @params)
        => @params?.ToString() ?? "";

    private static void Use(Func<string, string> transform)
    {
    }
}`)
        Assert.Contains("(params_ string) -> W.Normalize(params_)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func MissingWrapperParameterName_UsesUniqueSyntheticFallback() {
        // Bound C# method-group conversions name every delegate slot; an
        // absent symbol is a defensive error-recovery corner only.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", "class C {}")})
        let usedNames = HashSet[string](StringComparer.Ordinal){"__arg0"}
        let name = WrapperParameterName(project.Compilation, ImmutableArray[IParameterSymbol].Empty, 0, usedNames)
        Assert.Equal("__arg0_", name)
        Assert.Contains(name, usedNames)
    }

    shared {
        private func WrapperParameterName(
            compilation Compilation,
            parameters ImmutableArray[IParameterSymbol],
            index int32,
            usedNames HashSet[string]
        ) string {
            let visitor = Assert.IsAssignableFrom[Type](
                typeof(CSharpToGSharpTranslator).GetNestedType("DeclarationVisitor", BindingFlags.NonPublic)
            )
            let method = Assert.IsAssignableFrom[MethodInfo](
                visitor.GetMethod("MethodGroupWrapperParameterName", BindingFlags.NonPublic | BindingFlags.Static)
            )
            return Assert.IsType[string](
                method.Invoke(nil, []object{EmittedNameAllocator.For(compilation), parameters, index, usedNames})
            )
        }

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
