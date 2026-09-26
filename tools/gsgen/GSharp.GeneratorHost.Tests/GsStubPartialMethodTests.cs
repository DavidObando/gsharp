// <copyright file="GsStubPartialMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using static GSharp.GeneratorHost.Tests.StubTestSupport;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0192 follow-on 2: how the ADR-0145 §B stub projects G# partial methods.
/// A lone declaring part (<c>partial func F() R;</c>, which gsc keeps after
/// GS0609 so the stub can see it) must reach a generator as a C# partial
/// method DEFINITION — a generator such as the Regex generator only fills in
/// a method that is declared <c>partial</c> with no body, and rejects any
/// other shape (SYSLIB1043).
/// </summary>
public class GsStubPartialMethodTests
{
    [Fact]
    public void LoneStaticDeclaringPart_RendersPartialDefinition_WithAttributesAndNoBody()
    {
        var stub = Project(@"
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(""\\d+"")
        private partial func Digits() Regex;
    }
}
");

        AssertParses(stub);
        var method = SingleMethod(stub, "Digits");
        Assert.True(method.Body == null && method.ExpressionBody == null, "declaring part must render body-less:\n" + stub);
        Assert.Equal(new[] { "private", "static", "partial" }, method.Modifiers.Select(m => m.Text));
        Assert.Equal("global::System.Text.RegularExpressions.Regex", method.ReturnType.ToString());
        var attribute = Assert.Single(method.AttributeLists.SelectMany(list => list.Attributes));
        Assert.Equal("global::System.Text.RegularExpressions.GeneratedRegexAttribute", attribute.Name.ToString());
        Assert.Equal("\"\\\\d+\"", attribute.ArgumentList.Arguments.Single().ToString());

        // Bound the way a generator sees it: a partial definition with no
        // implementation yet (the generator supplies it).
        var symbol = DeclaredMethod(stub, "Digits");
        Assert.True(symbol.IsPartialDefinition);
        Assert.Null(symbol.PartialImplementationPart);
        Assert.True(symbol.IsStatic);
        Assert.Equal(Accessibility.Private, symbol.DeclaredAccessibility);
    }

    [Fact]
    public void LoneInstanceDeclaringPart_WithParameters_RendersPartialDefinition()
    {
        var stub = Project(@"
package App

partial class Model {
    partial func OnNameChanged(value string, count int32);
}
");

        AssertParses(stub);
        var method = SingleMethod(stub, "OnNameChanged");
        Assert.Null(method.Body);
        Assert.Null(method.ExpressionBody);
        Assert.Equal("partial", method.Modifiers.Last().Text);
        Assert.DoesNotContain(method.Modifiers, m => m.Text == "static");
        Assert.Equal("void", method.ReturnType.ToString());
        Assert.Equal("(string value, int count)", method.ParameterList.ToString());
        Assert.True(DeclaredMethod(stub, "OnNameChanged").IsPartialDefinition);
    }

    [Fact]
    public void DeclaringAndImplementingPair_RendersDefinitionPlusImplementation_ThatBindsClean()
    {
        var stub = Project(@"
package App

partial class Config {
    shared {
        @Obsolete
        partial func Version() int32;
    }
}

partial class Config {
    shared {
        partial func Version() int32 {
            return 7
        }
    }
}
");

        AssertParses(stub);
        var parts = Methods(stub, "Version");
        Assert.Equal(2, parts.Count);
        var definition = Assert.Single(parts, p => p.Body == null && p.ExpressionBody == null);
        var implementation = Assert.Single(parts, p => p.ExpressionBody != null);
        Assert.Contains(definition.Modifiers, m => m.Text == "partial");
        Assert.Contains(implementation.Modifiers, m => m.Text == "partial");

        // The merged symbol's attributes are the union of both parts; they are
        // stated once, on the definition, so C# does not see a duplicate.
        Assert.Single(definition.AttributeLists.SelectMany(list => list.Attributes));
        Assert.Empty(implementation.AttributeLists);

        var errors = BindStub(stub).GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        Assert.True(errors.Count == 0, stub + "\n" + string.Join("\n", errors));
        var symbol = DeclaredMethod(stub, "Version");
        Assert.True(symbol.IsPartialDefinition);
        Assert.NotNull(symbol.PartialImplementationPart);
    }

    [Fact]
    public void LoneImplementingPart_RendersOrdinaryMethod_AsBefore()
    {
        // GS0610 (one implementing part, no declaring part): gsc keeps the
        // implementing part as the survivor, and the stub keeps rendering it
        // as an ordinary method with an elided body.
        var stub = Project(@"
package App

partial class Config {
    partial func Version() int32 {
        return 7
    }
}
");

        AssertParses(stub);
        var method = SingleMethod(stub, "Version");
        Assert.DoesNotContain(method.Modifiers, m => m.Text == "partial");
        Assert.Equal("throw null!", method.ExpressionBody?.Expression.ToString());
    }

    [Fact]
    public void TwoDeclaringPartsNoImplementation_RecoverySurvivorRendersOrdinaryMethod()
    {
        // GS0610 (two declaring parts, no implementing part): gsc keeps ONE
        // bodiless declaring part to recover. It is not a lone definition, so
        // the stub must not offer it to generators to implement (which would
        // turn the real error into a 2-declaring/1-implementing cascade).
        var stub = Project(@"
package App

partial class Config {
    partial func Version() int32;
    partial func Version() int32;
}
");

        AssertParses(stub);
        var method = SingleMethod(stub, "Version");
        Assert.DoesNotContain(method.Modifiers, m => m.Text == "partial");
    }

    [Fact]
    public void DeclaringPartInNonPartialType_RendersOrdinaryMethod()
    {
        // GS0608: a partial method outside a partial type. A C# partial method
        // in a non-partial class would be a stub error of its own, and a
        // generator would then augment a type the user never made partial, so
        // the stub keeps the pre-ADR-0192 ordinary shape.
        var stub = Project(@"
package App

class Plain {
    partial func F() int32;
}
");

        AssertParses(stub);
        var method = SingleMethod(stub, "F");
        Assert.DoesNotContain(method.Modifiers, m => m.Text == "partial");
    }

    // ADR-0192 amendment (partial data types): a `partial data class` /
    // `partial data struct` is the G# spelling of a C# `partial record` /
    // `partial record struct`, so the stub offers it to a generator as one —
    // a generator that checks `IsRecord`, or re-declares the type with the
    // keyword it saw (the Regex generator does), then sees the real shape. The
    // record's synthesized members are the C# compiler's to supply, and the
    // stub must bind without errors.
    [Theory]
    [InlineData("sealed partial data class", "record", false)]
    [InlineData("partial data struct", "record struct", true)]
    public void DeclaringPartInAPartialDataType_RendersAPartialRecord_ThatBindsClean(string gsHeader, string csKeyword, bool isValueType)
    {
        var stub = Project(@"
package App
import System.Text.RegularExpressions

HEADER Url(Owner string, Name string, Pr int32?) {
    func Describe() string {
        return Owner + ""/"" + Name
    }

    shared {
        @GeneratedRegex(""\\d+"")
        private partial func Digits() Regex;
    }
}
".Replace("HEADER", gsHeader, System.StringComparison.Ordinal));

        AssertParses(stub);
        var type = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(stub).GetRoot()
            .DescendantNodes()
            .OfType<RecordDeclarationSyntax>()
            .SingleOrDefault(t => t.Identifier.Text == "Url");
        Assert.True(type != null, "expected a record declaration in:\n" + stub);
        Assert.Contains("partial " + csKeyword + " Url", type.ToString(), System.StringComparison.Ordinal);

        var compilation = BindStub(stub);
        // CS8795 (a partial method with accessibility has no implementation)
        // is the expected state of a lone declaring part: the generator
        // supplies the implementation.
        var errors = compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error && d.Id != "CS8795")
            .ToList();
        Assert.True(errors.Count == 0, stub + "\n\n" + string.Join("\n", errors));

        var symbol = compilation.GetTypeByMetadataName("App.Url");
        Assert.NotNull(symbol);
        Assert.True(symbol.IsRecord);
        Assert.Equal(isValueType, symbol.IsValueType);
        Assert.Equal(new[] { "Name", "Owner", "Pr" }, symbol.GetMembers().OfType<IPropertySymbol>().Where(p => p.Name != "EqualityContract").Select(p => p.Name).OrderBy(n => n));
        Assert.True(DeclaredMethod(stub, "Digits").IsPartialDefinition);
    }

    private static System.Collections.Generic.List<MethodDeclarationSyntax> Methods(string stub, string name) =>
        Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(stub).GetRoot()
            .DescendantNodes()
            .OfType<MethodDeclarationSyntax>()
            .Where(m => m.Identifier.Text == name)
            .ToList();

    private static MethodDeclarationSyntax SingleMethod(string stub, string name)
    {
        var methods = Methods(stub, name);
        Assert.True(methods.Count == 1, $"expected one '{name}' in:\n{stub}");
        return methods[0];
    }

    private static IMethodSymbol DeclaredMethod(string stub, string name)
    {
        var compilation = BindStub(stub);
        var tree = compilation.SyntaxTrees.Single();
        var model = compilation.GetSemanticModel(tree);
        var node = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>()
            .First(m => m.Identifier.Text == name);

        // Normalise to the definition part whichever part is found first.
        var symbol = (IMethodSymbol)model.GetDeclaredSymbol(node);
        return symbol.PartialDefinitionPart ?? symbol;
    }
}
