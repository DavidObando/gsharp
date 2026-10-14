// <copyright file="GsStubPartialMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import GSharp.GeneratorHost.Tests.StubTestSupport
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0192 follow-on 2: how the ADR-0145 §B stub projects G# partial methods.
/// A lone declaring part (`partial func F() R;`, which gsc keeps after
/// GS0609 so the stub can see it) must reach a generator as a C# partial
/// method DEFINITION — a generator such as the Regex generator only fills in
/// a method that is declared `partial` with no body, and rejects any
/// other shape (SYSLIB1043).
open class GsStubPartialMethodTests {
    @Fact
    func LoneStaticDeclaringPart_RendersPartialDefinition_WithAttributesAndNoBody() {
        let stub = StubTestSupport.Project(`
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("\\d+")
        private partial func Digits() Regex;
    }
}
`)
        AssertParses(stub)
        let method = SingleMethod(stub, "Digits")
        Assert.True(
            method.Body == nil && method.ExpressionBody == nil,
            "declaring part must render body-less:\n" + stub
        )
        Assert.Equal([]string{"private", "static", "partial"}, method.Modifiers.Select((m SyntaxToken) -> m.Text))
        Assert.Equal("global::System.Text.RegularExpressions.Regex", method.ReturnType.ToString())
        let attribute = Assert.Single(
            method.AttributeLists.SelectMany(
                func (list AttributeListSyntax) IEnumerable[AttributeSyntax] {
                    return list.Attributes
                }
            )
        )
        Assert.Equal("global::System.Text.RegularExpressions.GeneratedRegexAttribute", attribute.Name.ToString())
        Assert.Equal("\"\\\\d+\"", attribute.ArgumentList!!.Arguments.Single().ToString())
        // Bound the way a generator sees it: a partial definition with no
        // implementation yet (the generator supplies it).
        let symbol IMethodSymbol? = DeclaredMethod(stub, "Digits")
        Assert.True(symbol!!.IsPartialDefinition)
        Assert.Null(symbol!!.PartialImplementationPart)
        Assert.True(symbol!!.IsStatic)
        Assert.Equal(Accessibility.Private, symbol!!.DeclaredAccessibility)
    }

    @Fact
    func LoneInstanceDeclaringPart_WithParameters_RendersPartialDefinition() {
        let stub = StubTestSupport.Project(`
package App

partial class Model {
    partial func OnNameChanged(value string, count int32);
}
`)
        AssertParses(stub)
        let method = SingleMethod(stub, "OnNameChanged")
        Assert.Null(method.Body)
        Assert.Null(method.ExpressionBody)
        Assert.Equal("partial", method.Modifiers.Last().Text)
        Assert.DoesNotContain(method.Modifiers, (m SyntaxToken) -> m.Text == "static")
        Assert.Equal("void", method.ReturnType.ToString())
        Assert.Equal("(string value, int count)", method.ParameterList.ToString())
        Assert.True(DeclaredMethod(stub, "OnNameChanged")!!.IsPartialDefinition)
    }

    @Fact
    func DeclaringAndImplementingPair_RendersDefinitionPlusImplementation_ThatBindsClean() {
        let stub = StubTestSupport.Project(`
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
`)
        AssertParses(stub)
        let parts = Methods(stub, "Version")
        Assert.Equal(2, parts.Count)
        let definition = Assert.Single(parts, (p MethodDeclarationSyntax) -> p.Body == nil && p.ExpressionBody == nil)
        let implementation = Assert.Single(parts, (p MethodDeclarationSyntax) -> p.ExpressionBody != nil)
        Assert.Contains(definition.Modifiers, (m SyntaxToken) -> m.Text == "partial")
        Assert.Contains(implementation.Modifiers, (m SyntaxToken) -> m.Text == "partial")
        // The merged symbol's attributes are the union of both parts; they are
        // stated once, on the definition, so C# does not see a duplicate.
        Assert.Single(
            definition.AttributeLists.SelectMany(
                func (list AttributeListSyntax) IEnumerable[AttributeSyntax] {
                    return list.Attributes
                }
            )
        )
        Assert.Empty(implementation.AttributeLists)
        let errors = BindStub(stub)
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToList()
        Assert.True(errors.Count == 0, stub + "\n" + string.Join("\n", errors))
        let symbol IMethodSymbol? = DeclaredMethod(stub, "Version")
        Assert.True(symbol!!.IsPartialDefinition)
        Assert.NotNull(symbol!!.PartialImplementationPart)
    }

    @Fact
    func LoneImplementingPart_RendersOrdinaryMethod_AsBefore() {
        // GS0610 (one implementing part, no declaring part): gsc keeps the
        // implementing part as the survivor, and the stub keeps rendering it
        // as an ordinary method with an elided body.
        let stub = StubTestSupport.Project(`
package App

partial class Config {
    partial func Version() int32 {
        return 7
    }
}
`)
        AssertParses(stub)
        let method = SingleMethod(stub, "Version")
        Assert.DoesNotContain(method.Modifiers, (m SyntaxToken) -> m.Text == "partial")
        Assert.Equal("throw null!", method.ExpressionBody?.Expression.ToString())
    }

    @Fact
    func TwoDeclaringPartsNoImplementation_RecoverySurvivorRendersOrdinaryMethod() {
        // GS0610 (two declaring parts, no implementing part): gsc keeps ONE
        // bodiless declaring part to recover. It is not a lone definition, so
        // the stub must not offer it to generators to implement (which would
        // turn the real error into a 2-declaring/1-implementing cascade).
        let stub = StubTestSupport.Project(`
package App

partial class Config {
    partial func Version() int32;
    partial func Version() int32;
}
`)
        AssertParses(stub)
        let method = SingleMethod(stub, "Version")
        Assert.DoesNotContain(method.Modifiers, (m SyntaxToken) -> m.Text == "partial")
    }

    @Fact
    func DeclaringPartInNonPartialType_RendersOrdinaryMethod() {
        // GS0608: a partial method outside a partial type. A C# partial method
        // in a non-partial class would be a stub error of its own, and a
        // generator would then augment a type the user never made partial, so
        // the stub keeps the pre-ADR-0192 ordinary shape.
        let stub = StubTestSupport.Project(`
package App

class Plain {
    partial func F() int32;
}
`)
        AssertParses(stub)
        let method = SingleMethod(stub, "F")
        Assert.DoesNotContain(method.Modifiers, (m SyntaxToken) -> m.Text == "partial")
    }

    // ADR-0192 amendment (partial data types): a `partial data class` /
    // `partial data struct` is the G# spelling of a C# `partial record` /
    // `partial record struct`, so the stub offers it to a generator as one —
    // a generator that checks `IsRecord`, or re-declares the type with the
    // keyword it saw (the Regex generator does), then sees the real shape. The
    // record's synthesized members are the C# compiler's to supply, and the
    // stub must bind without errors.
    @Theory
    @InlineData("sealed partial data class", "record", false)
    @InlineData("partial data struct", "record struct", true)
    func DeclaringPartInAPartialDataType_RendersAPartialRecord_ThatBindsClean(
        gsHeader string,
        csKeyword string,
        isValueType bool
    ) {
        let stub = StubTestSupport.Project(`
package App
import System.Text.RegularExpressions

HEADER Url(Owner string, Name string, Pr int32?) {
    func Describe() string {
        return Owner + "/" + Name
    }

    shared {
        @GeneratedRegex("\\d+")
        private partial func Digits() Regex;
    }
}
`.Replace("HEADER", gsHeader, StringComparison.Ordinal))
        AssertParses(stub)
        let type RecordDeclarationSyntax? = CSharpSyntaxTree
            .ParseText(stub)
            .GetRoot()
            .DescendantNodes()
            .OfType[RecordDeclarationSyntax]()
            .SingleOrDefault((t RecordDeclarationSyntax) -> t.Identifier.Text == "Url")
        Assert.True(type != nil, "expected a record declaration in:\n" + stub)
        Assert.Contains("partial " + csKeyword + " Url", type!!.ToString(), StringComparison.Ordinal)
        let compilation = BindStub(stub)
        // CS8795 (a partial method with accessibility has no implementation)
        // is the expected state of a lone declaring part: the generator
        // supplies the implementation.
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error && d.Id != "CS8795")
            .ToList()
        Assert.True(errors.Count == 0, stub + `

` + string.Join("\n", errors))
        let symbol INamedTypeSymbol? = compilation.GetTypeByMetadataName("App.Url")
        Assert.NotNull(symbol)
        Assert.True(symbol!!.IsRecord)
        Assert.Equal(isValueType, symbol!!.IsValueType)
        Assert.Equal(
            []string{"Name", "Owner", "Pr"},
            symbol!!
                .GetMembers()
                .OfType[IPropertySymbol]()
                .Where((p IPropertySymbol) -> p.Name != "EqualityContract")
                .Select((p IPropertySymbol) -> p.Name)
                .OrderBy((n string) -> n)
        )
        Assert.True(DeclaredMethod(stub, "Digits")!!.IsPartialDefinition)
    }

    // Every data type with no base class now renders as a record, not only one
    // with partial funcs, so the other data shapes must still bind: an extra
    // constructor, a variadic or defaulted positional parameter, a generic
    // data class, and a non-positional data struct with fields.
    @Theory
    @InlineData(`data class Q(A int32) {
    init(s string) {
        A = 1
    }
}`)
    @InlineData("data class Names(prefix string, items ...string)")
    @InlineData("data class D(A int32, B string = \"x\")")
    @InlineData("data class Box[T](Value T)")
    @InlineData(`data struct Point {
    var X int32
    var Y int32
}`)
    @InlineData("data class Lower(x int32)")
    func DataTypeShapes_RenderAsRecordsThatBindClean(declaration string) {
        let stub = StubTestSupport.Project(`package App

` + declaration + "\n")
        AssertParses(stub)
        let errors = BindStub(stub)
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToList()
        Assert.True(errors.Count == 0, stub + `

` + string.Join("\n", errors))
        Assert.Contains(
            " record ",
            stub.Replace("record struct", "record ", StringComparison.Ordinal),
            StringComparison.Ordinal
        )
    }

    // Records are planned across the inheritance graph: a C# record derives
    // only from a record (CS8864) and only a record derives from one (CS8865),
    // so a data type renders as a record only when its whole chain can. Each
    // row lists the types expected as records; every other type is a class.
    @Theory
    @InlineData("open data class Base(A int32)\ndata class Derived(A int32, B int32) : Base(A)", "Base,Derived")
    @InlineData(`open data class Base(A int32)
class Plain : Base(1) {
}`, "")
    @InlineData(`open data class Root(A int32)
open data class Mid(A int32) : Root(A)
class Leaf : Mid(1) {
}
data class Other(A int32) : Root(A)`, "")
    @InlineData(`open class Entity {
}
data class Tag(Name string) : Entity`, "")
    @InlineData(`open class Entity {
}
data class Tag(Name string) : Entity
data class Free(A int32)`, "Free")
    func DataTypeHierarchies_RenderRecordsOnlyWhereTheWholeChainCan(declarations string, expectedRecords string) {
        let stub = StubTestSupport.Project(`package App

` + declarations + "\n")
        AssertParses(stub)
        let compilation = BindStub(stub)
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToList()
        Assert.True(errors.Count == 0, stub + `

` + string.Join("\n", errors))
        let records = compilation
            .GetSymbolsWithName((_ string) -> true, SymbolFilter.Type)
            .OfType[INamedTypeSymbol]()
            .Where((type INamedTypeSymbol) -> type.IsRecord)
            .Select((type INamedTypeSymbol) -> type.Name)
            .OrderBy((name string) -> name, StringComparer.Ordinal)
        Assert.Equal(expectedRecords.Split(',', StringSplitOptions.RemoveEmptyEntries), records)
    }

    shared {
        private func Methods(stub string, name string) List[MethodDeclarationSyntax] -> CSharpSyntaxTree
            .ParseText(stub)
            .GetRoot()
            .DescendantNodes()
            .OfType[MethodDeclarationSyntax]()
            .Where((m MethodDeclarationSyntax) -> m.Identifier.Text == name)
            .ToList()

        private func SingleMethod(stub string, name string) MethodDeclarationSyntax {
            let methods = Methods(stub, name)
            Assert.True(methods.Count == 1, (`expected one '` + "$name" + `' in:
` + "$stub"))
            return methods[0]
        }

        private func DeclaredMethod(stub string, name string) IMethodSymbol? {
            let compilation = BindStub(stub)
            let tree = compilation.SyntaxTrees.Single()
            let model = compilation.GetSemanticModel(tree)
            let node = tree
                .GetRoot()
                .DescendantNodes()
                .OfType[MethodDeclarationSyntax]()
                .First((m MethodDeclarationSyntax) -> m.Identifier.Text == name)
            // Normalise to the definition part whichever part is found first.
            let symbol IMethodSymbol? = cast[IMethodSymbol](model.GetDeclaredSymbol(node))
            return symbol!!.PartialDefinitionPart ?? symbol
        }
    }
}
