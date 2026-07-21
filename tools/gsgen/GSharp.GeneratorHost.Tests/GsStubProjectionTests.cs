// <copyright file="GsStubProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0145 §B: tests for the G#-&gt;C# declaration-only stub projection — the
/// input a Roslyn <c>ForAttributeWithMetadataName</c> generator matches on.
/// </summary>
public class GsStubProjectionTests
{
    [Fact]
    public void PartialClass_WithFieldAndMethod_RendersPartialAndElidedBodies()
    {
        var stub = Project(@"
partial class Greeter {
    var name string
    func Greet(times int32) string { return name }
}
");

        Assert.StartsWith("#nullable enable", stub);
        Assert.Contains("partial class Greeter", stub);
        Assert.Contains("string name;", stub);
        Assert.Contains("Greet(int times)", stub);
        Assert.Contains("=> throw null!", stub);
    }

    [Fact]
    public void Primitives_SpelledAsCSharpKeywords_InMethodSignature()
    {
        var stub = Project(@"
class Prims {
    func F(a int32, b uint8, c int8, d int16, e uint16, f uint32, g int64, h uint64, i float32, j float64, k bool, l char, m string) {}
}
");

        Assert.Contains("int a", stub);
        Assert.Contains("byte b", stub);
        Assert.Contains("sbyte c", stub);
        Assert.Contains("short d", stub);
        Assert.Contains("ushort e", stub);
        Assert.Contains("uint f", stub);
        Assert.Contains("long g", stub);
        Assert.Contains("ulong h", stub);
        Assert.Contains("float i", stub);
        Assert.Contains("double j", stub);
        Assert.Contains("bool k", stub);
        Assert.Contains("char l", stub);
        Assert.Contains("string m", stub);
    }

    [Fact]
    public void NullableField_RendersWithQuestionMark()
    {
        var stub = Project(@"
class Holder {
    var x string?
}
");

        Assert.Contains("string? x;", stub);
    }

    [Fact]
    public void GenericClass_RendersAngleBrackets()
    {
        var stub = Project(@"
class Box[T] {
    var value T
}
");

        Assert.Contains("class Box<T>", stub);
        Assert.Contains("T value;", stub);
    }

    [Fact]
    public void BclAttribute_OnMethod_RendersFullyQualifiedName()
    {
        var stub = Project(@"
class Svc {
    @Obsolete(""use Bar"")
    func Foo() {}
}
");

        Assert.Contains("[global::System.ObsoleteAttribute(\"use Bar\")]", stub);
    }

    [Fact]
    public void UserAttribute_OnType_RendersGlobalQualifiedName()
    {
        var stub = Project(@"
package Sample.Attrs

class MarkAttribute : Attribute {
}

@Mark
class Widget {
}
");

        Assert.Contains("[global::Sample.Attrs.MarkAttribute]", stub);
        Assert.Contains("class Widget", stub);
    }

    [Fact]
    public void SequenceReturnType_RendersAsIEnumerable()
    {
        var stub = Project(@"
class Seqs {
    func Numbers() sequence[int32] { }
}
");

        Assert.Contains("global::System.Collections.Generic.IEnumerable<int>", stub);
    }

    [Fact]
    public void AsyncMethods_RenderObservableTaskReturnTypes()
    {
        var stub = Project(@"
class Commands {
    async func Run() {}
    async func GetCount() int32 { return 1 }
}
");

        Assert.Contains("global::System.Threading.Tasks.Task Run()", stub);
        Assert.Contains("global::System.Threading.Tasks.Task<int> GetCount()", stub);
        Assert.DoesNotContain("void Run()", stub);
    }

    [Fact]
    public void NonPartialClass_RendersWithoutPartial()
    {
        var stub = Project(@"
class Plain {
    var a int32
}
");

        Assert.Contains("class Plain", stub);
        Assert.DoesNotContain("partial class Plain", stub);
    }

    [Fact]
    public void PackagedType_RendersInsideNamespace()
    {
        var stub = Project(@"
package Acme.Widgets

class Gadget {
    var id int32
}
");

        Assert.Contains("namespace Acme.Widgets", stub);
        Assert.Contains("class Gadget", stub);
    }

    [Fact]
    public void RenderedStub_ParsesAsValidCSharp()
    {
        var stub = Project(@"
package Sample

@Obsolete
class Account {
    var Balance decimal
    var Owner string?

    func Deposit(amount decimal) bool { return true }
    func Nothing() {}
}

class MarkAttribute : Attribute {
}

interface IShape {
    func Area() float64;
}

enum Color {
    Red
    Green
    Blue
}
");

        var parsed = CSharpSyntaxTree.ParseText(stub);
        var errors = parsed.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();

        Assert.True(errors.Count == 0, "Stub did not parse as valid C#:\n" + stub + "\n\n" + string.Join("\n", errors));
    }

    private static string Project(string gsSource)
    {
        var tree = GsSyntaxTree.Parse(SourceText.From(gsSource));
        var compilation = new Compilation(tree);
        return GsToCSharpProjection.ProjectToCSharp(compilation);
    }
}
