// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue5609AuthorSuppressionTests {
    @Fact
    func UnknownTypeParameterStorage_KeepsItsAuthorAssertion() {
        AssertRuns(`
#nullable disable
namespace Demo {
    public static class P {
        public static object Unknown<T>(T q) {
            T x;
            x = q;
            return x!;
        }
    }
}`, `
public static class Host {
    public static void Main() {
        string reference;
        try { reference = Demo.P.Unknown<string>(null) == null ? "nil" : "value"; }
        catch (System.NullReferenceException) { reference = "NRE"; }
        System.Console.Write(reference + ":" + Demo.P.Unknown<int>(7));
    }
}`, "NRE:7", (printed string) -> Assert.Contains("return x!!", printed), nativeExpected: "nil:7")
    }

    @Theory
    @InlineData("#nullable disable")
    @InlineData("#nullable enable")
    func AnalyzerNamespaceValues_KeepRequiredAssertionsInEveryCaptureForm(directive string) {
        AssertRuns((`
DIRECTIVE
namespace Demo {
    public class Holder {
        public Holder(Microsoft.CodeAnalysis.INamespaceSymbol child) { Child = child; }
        public Microsoft.CodeAnalysis.INamespaceSymbol Child { get; }
    }
    public static class P {
        public static object Direct(Microsoft.CodeAnalysis.INamespaceSymbol ns) => ns!;
        public static object Local(Microsoft.CodeAnalysis.INamespaceSymbol ns) { var x = ns; return x!; }
        public static object Is(Microsoft.CodeAnalysis.INamespaceSymbol ns) => ns is var c ? c! : new object();
        public static object Arm(Microsoft.CodeAnalysis.INamespaceSymbol ns) => ns switch { var c => c! };
        public static object Case(Microsoft.CodeAnalysis.INamespaceSymbol ns) { switch (ns) { case var c: return c!; } }
        public static object Property(Holder h) => h is { Child: var c } ? c! : new object();
        public static object Callable(Microsoft.CodeAnalysis.INamespaceSymbol ns) {
            var read = () => ns;
            return read!()!;
        }
        public static object Guarded(Microsoft.CodeAnalysis.INamespaceSymbol ns) {
            if (ns == null) return "nil";
            return ns!;
        }
    }
}`).Replace("DIRECTIVE", directive), `
using Demo;
public static class Host {
    static string Read(System.Func<object> f) {
        try { return f() == null ? "nil" : "value"; }
        catch (System.NullReferenceException) { return "NRE"; }
    }
    public static void Main() {
        System.Console.Write(Read(() => P.Direct(null)) + "|" + Read(() => P.Local(null)) + "|" +
            Read(() => P.Is(null)) + "|" + Read(() => P.Arm(null)) + "|" + Read(() => P.Case(null)) + "|" +
            Read(() => P.Property(new Holder(null))) + "|" + Read(() => P.Callable(null)) + "|" + P.Guarded(null));
    }
}`, "NRE|NRE|NRE|NRE|NRE|NRE|NRE|nil", (
                printed string
            ) -> {
                Assert.Contains(
                    "func Direct(ns string?) object -> ns!!",
                    printed
                )
                Assert.Contains(
                    "return x!!",
                    printed
                )
                Assert.Contains(
                    "c!!",
                    printed
                )
                Assert.Contains(
                    "return read()!!",
                    printed
                )
                Assert.DoesNotContain(
                    "return ns!!",
                    printed
                )
            }, nativeExpected: "nil|nil|nil|nil|nil|nil|nil|nil", analyzerApiMode: true)
    }

    @Fact
    func ObliviousNonNullDeclarations_OmitAuthorAssertionsInEveryCaptureForm() {
        AssertRuns(`
#nullable disable
namespace Demo {
    public class Node { }
    public class Holder {
        public Holder(Node child) { Child = child; }
        public Node Child { get; }
    }
    public class Box<T> {
        public Box(T value) { Value = value; }
        public T Value { get; }
    }
    public class Sink { public virtual string Take(Node n) => "taken"; }
    public static class P {
        public static string Direct(Node p) => new Sink().Take(p!);
        public static string Local(Node q) { var x = q; return new Sink().Take(x!); }
        public static string Is(Node q) => q is var c ? new Sink().Take(c!) : "none";
        public static string Arm(Node q) => q switch { var c => new Sink().Take(c!) };
        public static string Case(Node q) { switch (q) { case var c: return new Sink().Take(c!); } }
        public static string Property(Holder h) => h is { Child: var c } ? new Sink().Take(c!) : "none";
        public static string PropertyArm(Holder h) => h switch { { Child: var c } => new Sink().Take(c!), _ => "none" };
        public static string PropertyCase(Holder h) {
            switch (h) { case { Child: var c }: return new Sink().Take(c!); default: return "none"; }
        }
        public static string Generic(Box<Node> b) => new Sink().Take(b.Value!);
        public static string GenericProperty(Box<Node> b) => b is { Value: var c } ? new Sink().Take(c!) : "none";
    }
}`, `
using Demo;
public static class Host {
    public static void Main() {
        System.Console.Write(string.Join("|", new[] {
            P.Direct(null), P.Local(null), P.Is(null), P.Arm(null), P.Case(null),
            P.Property(new Holder(null)), P.PropertyArm(new Holder(null)), P.PropertyCase(new Holder(null)),
            P.Generic(new Box<Node>(null)), P.GenericProperty(new Box<Node>(null))
        }));
    }
}`, "taken|taken|taken|taken|taken|taken|taken|taken|taken|taken", (
                printed string
            ) -> {
                Assert.Contains(
                    "func Direct(p Node)",
                    printed
                )
                Assert.Contains(
                    "prop Child Node {",
                    printed
                )
                Assert.DoesNotContain(
                    "!!",
                    printed
                )
            })
    }

    @Theory
    @InlineData("#nullable enable", "Node?", "")
    @InlineData("#nullable disable", "Node", "if (q == null) { Field = q; }")
    func NullableAndWidenedDeclarations_KeepRequiredAuthorAssertions(directive string, type string, widening string) {
        let source = `
DIRECTIVE
using System.Collections.Generic;
namespace Demo {
    public class Node { }
    public static class P {
        static TYPE Field;
        static readonly List<Node> Items = new List<Node>();
        public static string Direct(TYPE q) { WIDEN Items.Add(q!); return "taken"; }
        public static string Is(TYPE q) { WIDEN return q is var c ? Add(c!) : "none"; }
        public static string Arm(TYPE q) { WIDEN return q switch { var c => Add(c!) }; }
        public static string Case(TYPE q) { WIDEN switch (q) { case var c: return Add(c!); } }
        static string Add(Node n) { Items.Add(n); return "taken"; }
    }
}`.Replace("DIRECTIVE", directive).Replace("TYPE", type).Replace("WIDEN", widening)
        AssertRuns(source, `
using Demo;
public static class Host {
    static string Read(System.Func<Node, string> f) {
        var nonnull = f(new Node());
        try { return nonnull + ":" + f(null); }
        catch (System.NullReferenceException) { return nonnull + ":NRE"; }
    }
    public static void Main() {
        System.Console.Write(Read(P.Direct) + "|" + Read(P.Is) + "|" + Read(P.Arm) + "|" + Read(P.Case));
    }
}`, "taken:NRE|taken:NRE|taken:NRE|taken:NRE", (
                printed string
            ) -> {
                Assert.Contains(
                    "func Direct(q Node?)",
                    printed
                )
                Assert.Contains(
                    "Items.Add(q!!)",
                    printed
                )
                Assert.Contains(
                    "Add(c!!)",
                    printed
                )
            }, nativeExpected: "taken:taken|taken:taken|taken:taken|taken:taken")
    }

    @Fact
    func UnknownFrozenObliviousRead_KeepsItsAuthorAssertion() {
        AssertRuns(`
#nullable disable
using LegacyLib;
namespace Demo {
    public static class P {
        static string Take(string s) => "taken";
        public static string Direct() => Take(Legacy.Read()!);
    }
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.P.Direct()); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "NRE", (
                printed string
            ) -> Assert.Contains(
                "Legacy.Read()!!",
                printed
            ), nativeExpected: "taken", legacySource: "namespace LegacyLib { public static class Legacy { public static string Read() => null; } }")
    }

    /// The non-null inferred store must assert, unlike the redundant author assertion on its initializer.
    @Fact
    func MaintainerDeconstructionRow_BridgesTheNonNullDestinationStore() {
        AssertRuns(`
#nullable disable
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Direct(Node q)
        {
            var x = q;
            int i;
            (x, i) = Empty();
            object o = x;
            return (o == null) + ":" + i;
        }
    }
}`, `
public static class Host {
    public static void Main() {
        try { System.Console.Write(Demo.Use.Direct(new Demo.Node())); }
        catch (System.NullReferenceException) { System.Console.Write("NRE"); }
    }
}`, "NRE", (printed string) -> Assert.Contains("x = xValue!!", printed), nativeExpected: "True:0")
    }

    shared {
        private func AssertRuns(
            source string,
            host string,
            expected string,
            verifyTranslation Action[string],
            nativeExpected string? = nil,
            legacySource string? = nil,
            analyzerApiMode bool = false
        ) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5609", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let references = List[MetadataReference](CSharpProjectLoader.RuntimeReferences())
                if analyzerApiMode {
                    let roslyn = typeof(INamespaceSymbol).Assembly.Location
                    File.Copy(roslyn, Path.Combine(directory, Path.GetFileName(roslyn)))
                }
                if legacySource != nil {
                    let legacyPath = Path.Combine(directory, "Legacy.dll")
                    EmitCSharp(legacySource, "Legacy", legacyPath, references)
                    references.Add(MetadataReference.CreateFromFile(legacyPath))
                }
                let project = CSharpProjectLoader.LoadInMemory(
                    [](string, string){("Probe.cs", source)},
                    references,
                    "Probe"
                )
                Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
                let document = Assert.Single(project.Documents)
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let printed = GSharpPrinter.Print(
                    CSharpToGSharpTranslator(analyzerApiMode: analyzerApiMode).TranslateDocument(document, context)
                )
                Assert.Empty(
                    context.Diagnostics.Where(
                        (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
                    )
                )
                let library = Path.Combine(directory, "Probe.dll")
                EmitCSharp(source, "Probe", library, references)
                let hostPath = Path.Combine(directory, "Host.dll")
                let hostReferences = List[MetadataReference](references){MetadataReference.CreateFromFile(library)}
                EmitCSharp(host, "Host", hostPath, hostReferences, OutputKind.ConsoleApplication)
                File.WriteAllText(
                    Path.Combine(directory, "Host.runtimeconfig.json"),
                    `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
                )
                AssertOutput(hostPath, nativeExpected ?? expected)
                let gs = Path.Combine(directory, "Probe.gs")
                File.WriteAllText(gs, printed)
                let compiler = LocalFunctionHoistTranslationTests.FindCompiler()
                Assert.NotNull(compiler)
                let arguments = List[string]{
                    compiler!!,
                    "/target:library",
                    "/assemblyname:Probe",
                    "/out:" + library,
                    gs
                }
                if legacySource != nil {
                    arguments.Add("/reference:" + Path.Combine(directory, "Legacy.dll"))
                }
                let compiled = ProcessRunner.Run("dotnet", arguments)
                Assert.False(compiled.TimedOut, compiled.Output)
                Assert.True(compiled.ExitCode == 0, compiled.Output + "\n" + printed)
                Assert.True(
                    !compiled.Output.Contains("GS0536", StringComparison.Ordinal),
                    compiled.Output + "\n" + printed
                )
                if analyzerApiMode {
                    EmitCSharp(
                        host,
                        "Host",
                        hostPath,
                        List[MetadataReference](references){MetadataReference.CreateFromFile(library)},
                        OutputKind.ConsoleApplication
                    )
                }
                VerifyStrictIL(library, directory)
                VerifyStrictIL(hostPath, directory)
                AssertOutput(hostPath, expected)
                verifyTranslation(printed)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func EmitCSharp(
            source string,
            name string,
            path string,
            references IEnumerable[MetadataReference],
            kind OutputKind = OutputKind.DynamicallyLinkedLibrary
        ) {
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, path: name + ".cs")},
                references,
                CSharpCompilationOptions(kind)
            )
            let result = compilation.Emit(path)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
        }

        private func AssertOutput(host string, expected string) {
            let run = ProcessRunner.Run("dotnet", []string{host})
            Assert.False(run.TimedOut, run.Output)
            Assert.Equal(0, run.ExitCode)
            Assert.Equal(string.Empty, run.Stderr)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(run.Stdout))
        }

        private func VerifyStrictIL(assembly string, directory string) {
            let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
            let references = Directory
                .EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
                .Concat(Directory.EnumerateFiles(directory, "*.dll"))
                .ToArray()
            Assert.NotEmpty(references)
            for reference in references {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            let result = ProcessRunner.Run("dotnet", arguments, IlVerifyRunner().RepoRoot)
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }
    }
}
