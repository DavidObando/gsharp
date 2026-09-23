// <copyright file="GsStubAttributeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using static GSharp.GeneratorHost.Tests.StubTestSupport;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0145 §B: attribute arguments must reach a generator with the same TYPE
/// and value the user wrote. gsc binds an enum argument to its underlying
/// primitive, and C# converts only the constant <c>0</c> implicitly to an enum,
/// so a bare <c>513</c> made <c>[GeneratedRegex("…", 513)]</c> bind to no
/// constructor and the Regex generator reported SYSLIB1040. The stub spells an
/// enum value as a cast to its enum type instead — exact for every value,
/// including flag combinations and values with no named member.
/// </summary>
public class GsStubAttributeArgumentTests
{
    [Fact]
    public void FlagsEnumArgument_RendersAsCastToEnumType_AndBindsTheEnumOverload()
    {
        var stub = Project(@"
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(""x"", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
        private partial func Rx() Regex;
    }
}
");

        Assert.Contains("(global::System.Text.RegularExpressions.RegexOptions)513", stub);
        var attribute = SingleAttribute(stub, "Rx");
        Assert.NotNull(attribute.AttributeConstructor);
        var options = attribute.ConstructorArguments[1];
        Assert.Equal("System.Text.RegularExpressions.RegexOptions", options.Type?.ToDisplayString());
        Assert.Equal(513, options.Value);
    }

    [Fact]
    public void NegativeEnumValue_IsParenthesized_SoTheCastIsNotReadAsSubtraction()
    {
        // `(E)-1` parses as `E - 1`; the operand must be parenthesized.
        var stub = Project(@"
package App
import System.ComponentModel
import System.Net.Sockets

class Holder {
    @DefaultValue(SocketError.SocketError)
    func F() {}
}
");

        Assert.Contains("(global::System.Net.Sockets.SocketError)(-1)", stub);
        var argument = SingleAttribute(stub, "F").ConstructorArguments.Single();
        Assert.Equal("System.Net.Sockets.SocketError", argument.Type?.ToDisplayString());
        Assert.Equal(-1, argument.Value);
    }

    [Fact]
    public void NonInt32UnderlyingEnums_KeepTheirEnumType_InPositionalAndNamedArguments()
    {
        // SecurityRuleSet is `: byte` and EventKeywords is `: long`. Through
        // DefaultValueAttribute(object) a bare number would bind as an `int`
        // and lose the enum type entirely; a named enum property rejects a
        // bare non-zero number outright.
        var stub = Project(@"
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
");

        var positional = SingleAttribute(stub, "F").ConstructorArguments.Single();
        Assert.Equal("System.Security.SecurityRuleSet", positional.Type?.ToDisplayString());
        Assert.Equal((byte)2, positional.Value);

        var named = SingleAttribute(stub, "G").NamedArguments.ToDictionary(pair => pair.Key, pair => pair.Value);
        Assert.Equal("System.Diagnostics.Tracing.EventLevel", named["Level"].Type?.ToDisplayString());
        Assert.Equal(3, named["Level"].Value);
        Assert.Equal("System.Diagnostics.Tracing.EventKeywords", named["Keywords"].Type?.ToDisplayString());
        Assert.Equal(0x10000000000000L, named["Keywords"].Value);
    }

    [Fact]
    public void SameCompilationEnumArgument_RendersAsCastToTheUserEnum()
    {
        var stub = Project(@"
package App
import System.ComponentModel

enum Status { Active, Retired }

class Holder {
    @DefaultValue(Status.Retired)
    func F() {}
}
");

        var argument = SingleAttribute(stub, "F").ConstructorArguments.Single();
        Assert.Equal("App.Status", argument.Type?.ToDisplayString());
        Assert.Equal(1, argument.Value);
    }

    [Fact]
    public void EnumArrayArguments_RenderAsTypedArrayCreations_WithCastElements()
    {
        // An array argument used to have no rendering at all (the renderer
        // omitted it with a note), which drops an enum array along with it.
        var stub = Project(@"
package App

class DaysAttribute(Days []DayOfWeek) : Attribute {
}

class ValuesAttribute(Values object) : Attribute {
}

class Holder {
    @Days([]DayOfWeek{DayOfWeek.Monday, DayOfWeek.Friday})
    func F() {}

    @Values([]object{[]DayOfWeek{DayOfWeek.Sunday}, DayOfWeek.Tuesday, ""s"", 4})
    func G() {}
}
");

        AssertParses(stub);
        Assert.Contains(
            "new global::System.DayOfWeek[] { (global::System.DayOfWeek)1, (global::System.DayOfWeek)5 }",
            stub);
        Assert.Contains(
            "new object[] { new global::System.DayOfWeek[] { (global::System.DayOfWeek)0 }, (global::System.DayOfWeek)2, \"s\", 4 }",
            stub);
    }

    [Fact]
    public void EnumParameterDefault_RendersAsCastToEnumType()
    {
        // Parameter defaults share the constant renderer, and `= 1` is not an
        // implicit conversion to an enum either.
        var stub = Project(@"
package App
import System.Text.RegularExpressions

class Holder {
    func F(options RegexOptions = RegexOptions.IgnoreCase) {}
}
");

        var compilation = BindStub(stub);
        Assert.DoesNotContain(compilation.GetDiagnostics(), d => d.Severity == DiagnosticSeverity.Error);
        var method = (IMethodSymbol)compilation.GetTypeByMetadataName("App.Holder").GetMembers("F").Single();
        Assert.Equal(1, method.Parameters.Single().ExplicitDefaultValue);
    }

    private static AttributeData SingleAttribute(string stub, string methodName)
    {
        var compilation = BindStub(stub);
        var tree = compilation.SyntaxTrees.Single();
        var node = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>()
            .First(m => m.Identifier.Text == methodName);
        var symbol = compilation.GetSemanticModel(tree).GetDeclaredSymbol(node);
        var attributes = symbol.GetAttributes();
        Assert.True(attributes.Length == 1, "expected one attribute on " + methodName + " in:\n" + stub);
        // CS8795 (a partial definition with accessibility but no
        // implementation) is the stub's intended shape: the generator supplies
        // the implementation.
        var errors = compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error && d.Id != "CS8795")
            .ToList();
        Assert.True(errors.Count == 0, stub + "\n" + string.Join("\n", errors));
        return attributes[0];
    }
}
