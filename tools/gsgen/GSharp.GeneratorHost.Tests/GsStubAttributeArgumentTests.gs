// <copyright file="GsStubAttributeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import GSharp.GeneratorHost.Tests.StubTestSupport
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0145 §B: attribute arguments must reach a generator with the same TYPE
/// and value the user wrote. gsc binds an enum argument to its underlying
/// primitive, and C# converts only the constant `0` implicitly to an enum,
/// so a bare `513` made `[GeneratedRegex("…", 513)]` bind to no
/// constructor and the Regex generator reported SYSLIB1040. The stub spells an
/// enum value as a cast to its enum type instead — exact for every value,
/// including flag combinations and values with no named member.
open class GsStubAttributeArgumentTests {
    @Fact
    func FlagsEnumArgument_RendersAsCastToEnumType_AndBindsTheEnumOverload() {
        let stub = StubTestSupport.Project(`
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("x", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
        private partial func Rx() Regex;
    }
}
`)
        Assert.Contains("(global::System.Text.RegularExpressions.RegexOptions)513", stub)
        let attribute = SingleAttribute(stub, "Rx")
        Assert.NotNull(attribute.AttributeConstructor)
        let options = attribute.ConstructorArguments[1]
        Assert.Equal("System.Text.RegularExpressions.RegexOptions", options.Type?.ToDisplayString())
        Assert.Equal(513, options.Value)
    }

    @Fact
    func NegativeEnumValue_IsParenthesized_SoTheCastIsNotReadAsSubtraction() {
        // `(E)-1` parses as `E - 1`; the operand must be parenthesized.
        let stub = StubTestSupport.Project(`
package App
import System.ComponentModel
import System.Net.Sockets

class Holder {
    @DefaultValue(SocketError.SocketError)
    func F() {}
}
`)
        Assert.Contains("(global::System.Net.Sockets.SocketError)(-1)", stub)
        let argument = SingleAttribute(stub, "F").ConstructorArguments.Single()
        Assert.Equal("System.Net.Sockets.SocketError", argument.Type?.ToDisplayString())
        Assert.Equal(-1, argument.Value)
    }

    @Fact
    func NonInt32UnderlyingEnums_KeepTheirEnumType_InPositionalAndNamedArguments() {
        // SecurityRuleSet is `: byte` and EventKeywords is `: long`. Through
        // DefaultValueAttribute(object) a bare number would bind as an `int`
        // and lose the enum type entirely; a named enum property rejects a
        // bare non-zero number outright.
        let stub = StubTestSupport.Project(`
package App
import System.ComponentModel
import System.Diagnostics.Tracing
import System.Security

class Holder {
    @DefaultValue(SecurityRuleSet.Level2)
    func F() {}

    @Event(1, Level: EventLevel.Warning, Keywords: EventKeywords.AuditFailure)
    func G() {}
}
`)
        let positional = SingleAttribute(stub, "F").ConstructorArguments.Single()
        Assert.Equal("System.Security.SecurityRuleSet", positional.Type?.ToDisplayString())
        Assert.Equal(uint8(2), positional.Value)
        let named = SingleAttribute(stub, "G").NamedArguments.ToDictionary(
            func (pair KeyValuePair[string, TypedConstant]) string {
                return pair.Key
            },
            (pair KeyValuePair[string, TypedConstant]) -> pair.Value
        )
        Assert.Equal("System.Diagnostics.Tracing.EventLevel", named["Level"].Type?.ToDisplayString())
        Assert.Equal(3, named["Level"].Value)
        Assert.Equal("System.Diagnostics.Tracing.EventKeywords", named["Keywords"].Type?.ToDisplayString())
        Assert.Equal(0x10000000000000L, named["Keywords"].Value)
    }

    @Fact
    func SameCompilationEnumArgument_RendersAsCastToTheUserEnum() {
        let stub = StubTestSupport.Project(`
package App
import System.ComponentModel

enum Status { Active, Retired }

class Holder {
    @DefaultValue(Status.Retired)
    func F() {}
}
`)
        let argument = SingleAttribute(stub, "F").ConstructorArguments.Single()
        Assert.Equal("App.Status", argument.Type?.ToDisplayString())
        Assert.Equal(1, argument.Value)
    }

    @Fact
    func EnumArrayArguments_RenderAsTypedArrayCreations_WithCastElements() {
        // An array argument used to have no rendering at all (the renderer
        // omitted it with a note), which drops an enum array along with it.
        let stub = StubTestSupport.Project(`
package App

class DaysAttribute(Days []DayOfWeek) : Attribute {
}

class ValuesAttribute(Values object) : Attribute {
}

class Holder {
    @Days([]DayOfWeek{DayOfWeek.Monday, DayOfWeek.Friday})
    func F() {}

    @Values([]object{[]DayOfWeek{DayOfWeek.Sunday}, DayOfWeek.Tuesday, "s", 4})
    func G() {}
}
`)
        AssertParses(stub)
        Assert.Contains(
            "new global::System.DayOfWeek[] { (global::System.DayOfWeek)1, (global::System.DayOfWeek)5 }",
            stub
        )
        Assert.Contains(
            "new object[] { new global::System.DayOfWeek[] { (global::System.DayOfWeek)0 }, (global::System.DayOfWeek)2, \"s\", 4 }",
            stub
        )
    }

    @Fact
    func SameCompilationTypeArrayNestedInObjectArray_RetainsItsStaticType() {
        let stub = StubTestSupport.Project(`
package App
import System

class ValuesAttribute(Values []object) : Attribute {
}

@Values([]object{[]Type{typeof(Local)}, []object{"control"}})
class Local {
}
`)
        AssertParses(stub)
        Assert.Contains("new global::System.Type[] { typeof(global::App.Local) }", stub)
        Assert.Contains("new global::System.Object[] { \"control\" }", stub)
    }

    @Fact
    func EnumParameterDefault_RendersAsCastToEnumType() {
        // Parameter defaults share the constant renderer, and `= 1` is not an
        // implicit conversion to an enum either.
        let stub = StubTestSupport.Project(`
package App
import System.Text.RegularExpressions

class Holder {
    func F(options RegexOptions = RegexOptions.IgnoreCase) {}
}
`)
        let compilation = BindStub(stub)
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let method = cast[IMethodSymbol](compilation.GetTypeByMetadataName("App.Holder")!!.GetMembers("F").Single())
        Assert.Equal(1, method.Parameters.Single().ExplicitDefaultValue)
    }

    @Fact
    func StringArgument_WithEveryCSharpLineTerminator_ParsesAndRoundTripsExactly() {
        // C# ends a regular string literal at CR, LF, U+0085, U+2028 and
        // U+2029. U+2028/U+2029 are not char.IsControl, so they used to be
        // written raw and cut the stub's literal short.
        let stub = StubTestSupport.Project(`
package App

class Holder {
    @Obsolete("a\u2028b\u2029c\u0085d\re\nf")
    func F() {}
}
`)
        AssertParses(stub)
        let argument = SingleAttribute(stub, "F").ConstructorArguments.Single()
        Assert.Equal("a b cd\re\nf", argument.Value)
    }

    @Fact
    func NamedConstructorArgument_PreservesItsParameterSlot() {
        let stub = StubTestSupport.Project(`
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("x", RegexOptions.None, matchTimeoutMilliseconds: 123)
        private partial func Rx() Regex;
    }
}
`)
        Assert.Contains("matchTimeoutMilliseconds: 123", stub)
        let attribute = SingleAttribute(stub, "Rx")
        Assert.Equal(123, attribute.ConstructorArguments[2].Value)
    }

    shared {
        private func SingleAttribute(stub string, methodName string) AttributeData {
            let compilation = BindStub(stub)
            let tree = compilation.SyntaxTrees.Single()
            let node = tree
                .GetRoot()
                .DescendantNodes()
                .OfType[MethodDeclarationSyntax]()
                .First((m MethodDeclarationSyntax) -> m.Identifier.Text == methodName)
            let symbol ISymbol? = compilation.GetSemanticModel(tree).GetDeclaredSymbol(node)
            let attributes = symbol!!.GetAttributes()
            Assert.True(attributes.Length == 1, "expected one attribute on " + methodName + " in:\n" + stub)
            // CS8795 (a partial definition with accessibility but no
            // implementation) is the stub's intended shape: the generator supplies
            // the implementation.
            let errors = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error && d.Id != "CS8795")
                .ToList()
            Assert.True(errors.Count == 0, stub + "\n" + string.Join("\n", errors))
            return attributes[0]
        }
    }
}
