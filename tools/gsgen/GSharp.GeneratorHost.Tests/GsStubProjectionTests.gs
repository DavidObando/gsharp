// <copyright file="GsStubProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Text
import GSharp.GeneratorHost
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System.Linq
import Xunit

/// ADR-0145 §B: tests for the G#->C# declaration-only stub projection — the
/// input a Roslyn `ForAttributeWithMetadataName` generator matches on.
open class GsStubProjectionTests {
    @Fact
    func PartialClass_WithFieldAndMethod_RendersPartialAndElidedBodies() {
        let stub = GsStubProjectionTests.Project(`
partial class Greeter {
    var name string
    func Greet(times int32) string { return name }
}
`)
        Assert.StartsWith("#nullable enable", stub)
        Assert.Contains("partial class Greeter", stub)
        Assert.Contains("string name;", stub)
        Assert.Contains("Greet(int times)", stub)
        Assert.Contains("=> throw null!", stub)
    }

    @Fact
    func Primitives_SpelledAsCSharpKeywords_InMethodSignature() {
        let stub = GsStubProjectionTests.Project(`
class Prims {
    func F(a int32, b uint8, c int8, d int16, e uint16, f uint32, g int64, h uint64, i float32, j float64, k bool, l char, m string) {}
}
`)
        Assert.Contains("int a", stub)
        Assert.Contains("byte b", stub)
        Assert.Contains("sbyte c", stub)
        Assert.Contains("short d", stub)
        Assert.Contains("ushort e", stub)
        Assert.Contains("uint f", stub)
        Assert.Contains("long g", stub)
        Assert.Contains("ulong h", stub)
        Assert.Contains("float i", stub)
        Assert.Contains("double j", stub)
        Assert.Contains("bool k", stub)
        Assert.Contains("char l", stub)
        Assert.Contains("string m", stub)
    }

    @Fact
    func NullableField_RendersWithQuestionMark() {
        let stub = GsStubProjectionTests.Project(`
class Holder {
    var x string?
}
`)
        Assert.Contains("string? x;", stub)
    }

    @Fact
    func GenericClass_RendersAngleBrackets() {
        let stub = GsStubProjectionTests.Project(`
class Box[T] {
    var value T
}
`)
        Assert.Contains("class Box<T>", stub)
        Assert.Contains("T value;", stub)
    }

    @Fact
    func BclAttribute_OnMethod_RendersFullyQualifiedName() {
        let stub = GsStubProjectionTests.Project(`
class Svc {
    @Obsolete("use Bar")
    func Foo() {}
}
`)
        Assert.Contains("[global::System.ObsoleteAttribute(\"use Bar\")]", stub)
    }

    @Fact
    func UserAttribute_OnType_RendersGlobalQualifiedName() {
        let stub = GsStubProjectionTests.Project(`
package Sample.Attrs

class MarkAttribute : Attribute {
}

@Mark
class Widget {
}
`)
        Assert.Contains("[global::Sample.Attrs.MarkAttribute]", stub)
        Assert.Contains("class Widget", stub)
    }

    @Fact
    func SequenceReturnType_RendersAsIEnumerable() {
        let stub = GsStubProjectionTests.Project(`
class Seqs {
    func Numbers() sequence[int32] { }
}
`)
        Assert.Contains("global::System.Collections.Generic.IEnumerable<int>", stub)
    }

    @Fact
    func AsyncMethods_RenderObservableTaskReturnTypes() {
        let stub = GsStubProjectionTests.Project(`
class Commands {
    async func Run() {}
    async func GetCount() int32 { return 1 }
}
`)
        Assert.Contains("global::System.Threading.Tasks.Task Run()", stub)
        Assert.Contains("global::System.Threading.Tasks.Task<int> GetCount()", stub)
        Assert.DoesNotContain("void Run()", stub)
    }

    @Fact
    func NonPartialClass_RendersWithoutPartial() {
        let stub = GsStubProjectionTests.Project(`
class Plain {
    var a int32
}
`)
        Assert.Contains("class Plain", stub)
        Assert.DoesNotContain("partial class Plain", stub)
    }

    @Fact
    func PackagedType_RendersInsideNamespace() {
        let stub = GsStubProjectionTests.Project(`
package Acme.Widgets

class Gadget {
    var id int32
}
`)
        Assert.Contains("namespace Acme.Widgets", stub)
        Assert.Contains("class Gadget", stub)
    }

    @Fact
    func RenderedStub_ParsesAsValidCSharp() {
        let stub = GsStubProjectionTests.Project(`
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
`)
        let parsed = CSharpSyntaxTree.ParseText(stub)
        let errors = parsed.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error).ToList()
        Assert.True(errors.Count == 0, "Stub did not parse as valid C#:\n" + stub + `

` + string.Join("\n", errors))
    }

    shared {
        private func Project(gsSource string) string {
            let tree = GsSyntaxTree.Parse(SourceText.From(gsSource))
            let compilation = Compilation(tree)
            return GsToCSharpProjection.ProjectToCSharp(compilation)
        }
    }
}
