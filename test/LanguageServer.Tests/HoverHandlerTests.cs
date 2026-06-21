// <copyright file="HoverHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class HoverHandlerTests
{
    [Theory]
    [InlineData("let answer = 42\n", "answer", "let answer int32")]
    [InlineData("var count = 0\n", "count", "var count int32")]
    [InlineData("func add(a int32, b int32) int32 { return a + b }\n", "add", "func add(a int32, b int32) int32")]
    [InlineData("func greet(name string) { }\n", "name", "name string")]
    [InlineData("struct Point {\nvar X int32\nvar Y int32\n}\n", "Point", "struct Point { var X int32; var Y int32 }")]
    [InlineData("enum Color { Red, Green }\n", "Color", "enum Color { Red, Green }")]
    [InlineData("import System\nfunc main() {\nConsole.WriteLine(\"hi\")\n}\n", "Console", "class System.Console")]
    public void ComputeHover_ReturnsMarkdownSignature(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("package P\nclass Person {\n    prop Name string\n}\n", "Name")]
    [InlineData("package P\nimport sys = System\n", "sys")]
    [InlineData("package Outer.Inner\n", "Outer")]
    [InlineData("package Outer.Inner\n", "Inner")]
    [InlineData("package P\nimport System\nclass Foo {\n  event Click (Object, EventArgs) -> void\n}\n", "Click")]
    public void ComputeHover_ResolvesPropertyImportPackageAndEventSymbols(string source, string token)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(token, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("func greet(name string) { }\n", "name", "(parameter) name string")]
    [InlineData("func f() {\nvar x = 5\nx = x + 1\n}\n", "x", "(local variable) x int32")]
    [InlineData("enum Color { Red, Green }\n", "Red", "Color.Red = 0")]
    [InlineData("enum Color { Red, Green }\n", "Green", "Color.Green = 1")]
    [InlineData("package P\nimport sys = System\n", "sys", "import sys = System")]
    [InlineData("package Outer.Inner\n", "Inner", "package Outer.Inner")]
    public void ComputeHover_RendersEnrichedDescriptors(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersPropertyAccessors()
    {
        const string source = "package P\nclass Person {\n    prop Name string\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Name string {", value, System.StringComparison.Ordinal);
        Assert.Contains("get;", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ResolvesPropertyOnUserDefinedClass()
    {
        const string source = "package P\nclass Person {\n    /// The name\n    prop Name string\n}\nfunc Main() {\n    var person = Person{}\n    var n = person.Name\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name", 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Name string", value, System.StringComparison.Ordinal);
        Assert.Contains("The name", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ResolvesFieldOnUserDefinedStruct()
    {
        const string source = "package P\nstruct Point {\n    /// X coordinate\n    var X int32\n    var Y int32\n}\nfunc Main() {\n    var p = Point{}\n    var x = p.X\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "X", 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("X int32", value, System.StringComparison.Ordinal);
        Assert.Contains("X coordinate", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ResolvesMethodOnUserDefinedClass()
    {
        const string source = "package P\nclass Person {\n    prop Name string\n    /// Says hello\n    func Greet() string { return \"hi\" }\n}\nfunc Main() {\n    var person = Person{}\n    person.Greet()\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Greet", 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Greet", value, System.StringComparison.Ordinal);
        Assert.Contains("Says hello", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ResolvesChainedUserDefinedAndClrMembers()
    {
        const string source = "package P\nclass Person {\n    /// The name of the person\n    prop Name string\n}\nfunc Main() {\n    var person = Person{}\n    var y = person.Name.GetType()\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var nameHover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name", 1));
        Assert.NotNull(nameHover);
        var nameValue = nameHover.Contents.ToString();
        Assert.Contains("Name string", nameValue, System.StringComparison.Ordinal);
        Assert.Contains("The name of the person", nameValue, System.StringComparison.Ordinal);

        var getTypeHover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "GetType"));
        Assert.NotNull(getTypeHover);
        Assert.Contains("GetType", getTypeHover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ResolvesFieldAssignmentOnUserDefinedClass()
    {
        const string source = "package P\nclass Person {\n    /// The age of the person\n    prop Age int32\n}\nfunc Main() {\n    var person = Person{}\n    person.Age = 30\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Age", 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Age int32", value, System.StringComparison.Ordinal);
        Assert.Contains("The age of the person", value, System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("func main() {\n    let x = 42\n}\n", "42", "int32")]
    [InlineData("func main() {\n    let x = 3.14\n}\n", "3.14", "float64")]
    [InlineData("func main() {\n    let x = \"hello\"\n}\n", "\"hello\"", "string")]
    [InlineData("func main() {\n    let x = true\n}\n", "true", "bool")]
    [InlineData("func main() {\n    let x = false\n}\n", "false", "bool")]
    public void ComputeHover_ShowsLiteralType(string source, string token, string expectedType)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains(expectedType, value, System.StringComparison.Ordinal);
        Assert.Contains(token, value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrInstancePropertyDocumentation()
    {
        const string source = "import System.Text\nfunc main() {\n    var sb = StringBuilder()\n    var length = sb.Length\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Length"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("System.Text.StringBuilder.Length", value, System.StringComparison.Ordinal);
        Assert.Contains("int32", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrFieldDocumentation()
    {
        const string source = "import System\nfunc main() {\n    var pi = Math.PI\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "PI"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("System.Math.PI", value, System.StringComparison.Ordinal);
        Assert.Contains("float64", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrEventDocumentation()
    {
        const string source = "import System\nfunc handler(sender Object, args ConsoleCancelEventArgs) { }\nfunc main() {\n    Console.CancelKeyPress += handler\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "CancelKeyPress"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("event", value, System.StringComparison.Ordinal);
        Assert.Contains("System.Console.CancelKeyPress", value, System.StringComparison.Ordinal);
        Assert.Contains("System.ConsoleCancelEventHandler", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrMethodDocumentation()
    {
        const string source = "import System\nfunc main() {\n    Console.WriteLine(\"hi\")\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "WriteLine"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("func", value, System.StringComparison.Ordinal);
        Assert.Contains("System.Console", value, System.StringComparison.Ordinal);
        Assert.Contains("WriteLine", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ResolvesAnnotationName_WithAttributeSuffixFallback()
    {
        const string source = "@Obsolete(\"Use NewApi\")\nfunc OldApi() { }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Obsolete"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("ObsoleteAttribute", value, System.StringComparison.Ordinal);
        Assert.Contains("System", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void AssemblyDocumentationProvider_ResolvesClrMemberDocsFromReferencePack()
    {
        var resolver = CreateReferencePackResolver();
        Assert.True(resolver.TryResolveType("System.Console", out var consoleType));
        Assert.True(resolver.TryResolveType("System.Math", out var mathType));
        Assert.True(resolver.TryResolveType("System.Text.StringBuilder", out var stringBuilderType));

        var title = consoleType.GetProperty("Title", BindingFlags.Public | BindingFlags.Static);
        var cancelKeyPress = consoleType.GetEvent("CancelKeyPress", BindingFlags.Public | BindingFlags.Static);
        var writeLine = consoleType.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == "WriteLine" && m.GetParameters().Length == 1);
        var pi = mathType.GetField("PI", BindingFlags.Public | BindingFlags.Static);
        var length = stringBuilderType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(title);
        Assert.NotNull(cancelKeyPress);
        Assert.NotNull(writeLine);
        Assert.NotNull(pi);
        Assert.NotNull(length);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(title).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(cancelKeyPress).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(writeLine).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(pi).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(length).Summary);
    }

    [Fact]
    public void ComputeHover_DoesNotAnnotateOverloadsForSingleFunction()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "add"));

        Assert.NotNull(hover);
        Assert.DoesNotContain("overload", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ThisKeyword_InsideClassMethod_ResolvesToReceiver()
    {
        const string source = "package P\nclass Person {\n    prop Name string\n    func ToString() string {\n        return \"${this.Name}\"\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Hover on 'this' should resolve to the implicit receiver parameter.
        var hoverThis = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "this"));
        Assert.NotNull(hoverThis);
        Assert.Contains("Person", hoverThis.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_MemberAccess_ViaThis_InsideClassMethod()
    {
        const string source = "package P\nclass Person {\n    prop Name string\n    func ToString() string {\n        return \"${this.Name}\"\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Hover on 'Name' in 'this.Name' should resolve to the property.
        var hoverName = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name", 1));
        Assert.NotNull(hoverName);
        Assert.Contains("Name", hoverName.Contents.ToString(), System.StringComparison.Ordinal);
        Assert.Contains("string", hoverName.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ImplicitThis_BarePropertyName_InsideClassMethod()
    {
        const string source = "package P\nclass Person {\n    prop Name string\n    prop Age int32\n    func Greet() string {\n        return Name\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Hover on bare 'Name' inside method body should resolve to the property via implicit this.
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name", 1));
        Assert.NotNull(hover);
        Assert.Contains("Name", hover.Contents.ToString(), System.StringComparison.Ordinal);
        Assert.Contains("string", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ExtensionMethodInvocation_ResolvesToMethod_NotSameNamedType()
    {
        // Issue #891 (Problem C): hovering the `Single` LINQ extension method must
        // resolve to that method, not to the type `System.Single` (float32) which
        // merely shares the name. Regression: previously hover showed
        // "struct float32 / Represents a single-precision floating-point number.".
        const string source =
            "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let nums = List[int32]()\n" +
            "    nums.Add(1)\n" +
            "    let found = nums.Single((x) -> x == 1)\n" +
            "    Console.WriteLine(found)\n" +
            "}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Single"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Single", value, System.StringComparison.Ordinal);
        Assert.DoesNotContain("float32", value, System.StringComparison.Ordinal);
        Assert.DoesNotContain("single-precision", value, System.StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ComputeHover_ExtensionMethodInvocation_DoesNotResolveToSameNamedStaticMethod()
    {
        // Issue #906: hovering an extension method invoked on a value receiver
        // (`a.Concat(b)` -> System.Linq.Enumerable.Concat) must not bind to an
        // unrelated, same-named *static* method that happens to appear elsewhere
        // in the program (`string.Concat(...)` -> System.String.Concat). The
        // whole-program same-name scan previously returned whichever bound call
        // it found first, ignoring which call the hovered token belonged to.
        const string source =
            "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let s = String.Concat(\"x\", \"y\")\n" +
            "    let a = List[int32]()\n" +
            "    let b = List[int32]()\n" +
            "    let joined = a.Concat(b)\n" +
            "    Console.WriteLine(s)\n" +
            "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Hover the `Concat` of the extension invocation `a.Concat(b)` (2nd occurrence):
        // its value receiver means it must bind to the LINQ extension method, never to
        // the unrelated same-named static `String.Concat`.
        var extHover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Concat", 1));
        Assert.NotNull(extHover);
        var extValue = extHover.Contents.ToString();
        Assert.Contains("Concat", extValue, System.StringComparison.Ordinal);
        Assert.Contains("Enumerable", extValue, System.StringComparison.Ordinal);

        // Hover the `Concat` of the static invocation `String.Concat("x", "y")` (1st occurrence):
        // its type-name receiver means it must bind to the static `String.Concat`, never
        // to the same-named LINQ extension method.
        var staticHover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Concat", 0));
        Assert.NotNull(staticHover);
        var staticValue = staticHover.Contents.ToString();
        Assert.Contains("Concat", staticValue, System.StringComparison.Ordinal);
        Assert.DoesNotContain("Enumerable", staticValue, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_DottedChainExtensionInvocation_ResolvesToExtension_NotSameNamedStatic()
    {
        // Issue #906: the user's real failing shape is a *dotted-chain* value
        // receiver — `report.Checks.Single(pred)`. Such a chain parses
        // right-associatively, so the hovered call's enclosing accessors yield
        // several candidate receivers (the bare trailing segment `Checks` and the
        // full `report.Checks`). Classifying off the bare trailing segment misread
        // the receiver as "no receiver" and let the call bind to an unrelated
        // same-named *static* method (e.g. `Xunit.Assert.Single`). This mirrors the
        // shape with BCL-only types: `d.Keys.Concat(other)` (a value-receiver LINQ
        // extension whose receiver is a property access) must never resolve to the
        // same-named static `String.Concat(...)` that appears elsewhere — even
        // though both have the same parameter count relative to the call site.
        const string source =
            "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let d = Dictionary[string, int32]()\n" +
            "    let other = List[string]()\n" +
            "    let joined = d.Keys.Concat(other)\n" +
            "    let s = String.Concat(\"x\", \"y\")\n" +
            "    Console.WriteLine(s)\n" +
            "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Concat", 0));
        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Concat", value, System.StringComparison.Ordinal);
        Assert.Contains("Enumerable", value, System.StringComparison.Ordinal);
        Assert.DoesNotContain("(System.String)", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_ExtensionMethodInvocation_WithFuncLiteral_ResolvesToMethod()
    {
        // The hover bug was independent of the argument form: the explicit
        // `func(...) bool { ... }` predicate spelling must also hover to the
        // method, not the float32 type.
        const string source =
            "package P\n" +
            "import System\n" +
            "import System.Linq\n" +
            "import System.Collections.Generic\n" +
            "func main() {\n" +
            "    let nums = List[int32]()\n" +
            "    nums.Add(1)\n" +
            "    let found = nums.Single(func(x int32) bool { return x == 1 })\n" +
            "    Console.WriteLine(found)\n" +
            "}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Single"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Single", value, System.StringComparison.Ordinal);
        Assert.DoesNotContain("single-precision", value, System.StringComparison.OrdinalIgnoreCase);
    }

    private static ReferenceResolver CreateReferencePackResolver()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var dotnetRoot = Directory.GetParent(runtimeDir).Parent.Parent.FullName;
        var major = System.Environment.Version.Major;
        var tfm = $"net{major}.0";

        // Discover the actual installed ref pack directory. Globbing rather
        // than hard-coding Environment.Version.ToString(3) tolerates the
        // common CI shape where the running runtime (e.g. "10.0.0") and the
        // installed ref pack (e.g. "10.0.9") have different patch versions
        // (#858). Pick the highest-versioned ref pack whose TFM directory
        // exists.
        var packRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        Assert.True(Directory.Exists(packRoot), $"Ref pack root '{packRoot}' not found.");

        var refDir = Directory.EnumerateDirectories(packRoot)
            .Select(d => new { Dir = d, Ref = Path.Combine(d, "ref", tfm) })
            .Where(x => Directory.Exists(x.Ref))
            .OrderByDescending(x => TryParseVersion(Path.GetFileName(x.Dir)))
            .Select(x => x.Ref)
            .FirstOrDefault();

        Assert.NotNull(refDir);
        return ReferenceResolver.WithReferences(Directory.GetFiles(refDir, "*.dll"));

        static Version TryParseVersion(string s) => Version.TryParse(s, out var v) ? v : new Version(0, 0);
    }
}
