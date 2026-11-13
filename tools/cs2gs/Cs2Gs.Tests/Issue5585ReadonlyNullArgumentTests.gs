// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue5585ReadonlyNullArgumentTests {
    @Theory
    @InlineData("if (stored != null) return int.Parse(stored); return -1;")
    @InlineData("if (this.stored != null) return int.Parse(stored); return -1;")
    @InlineData("if (stored == null) return -1; else return int.Parse(this.stored);")
    @InlineData("return stored != null ? int.Parse(this.stored) : -1;")
    @InlineData("if (stored == null) return -1; return int.Parse(stored);")
    @InlineData("while (stored != null) return int.Parse(stored); return -1;")
    @InlineData("for (; stored != null;) return int.Parse(stored); return -1;")
    @InlineData("if (stored != null) { GC.KeepAlive(this); return int.Parse(stored); } return -1;")
    func GuardedReadonlyStore_PreservesNullAndNumericValues(body string) {
        let source = `
#nullable enable
using System;
public class Holder {
    private readonly string stored;
    private static int evaluations;
    private static string Next() { evaluations++; return "42"; }
    public Holder(string p) { stored = p; }
    public int Parse() { BODY }
    public static void Main() {
        Console.Write(new Holder(null!).Parse() + "|" + new Holder(Next()).Parse() + "|" + evaluations);
    }
}
`.Replace("BODY", body)
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Assert.Contains("init(p string?)", printed)
                Assert.Contains("stored string?", printed)
                AssertClean(printed)
            },
            verifyAssembly: (assembly string) -> {
                VerifyStrictIL(assembly)
                let result = ProcessRunner.Run("dotnet", []string{assembly})
                Assert.Equal(0, result.ExitCode)
                Assert.Equal(string.Empty, result.Stderr)
                Assert.Equal(Encoding.UTF8.GetBytes("-1|42|1"), Encoding.UTF8.GetBytes(result.Stdout))
            }
        )
    }

    @Theory
    @InlineData("readonly", "if (stored != null) return int.Parse(stored); return -1;", true)
    @InlineData("readonly", "if (this.stored != null) return int.Parse(stored); return -1;", true)
    @InlineData("", "if (stored != null) return int.Parse(stored); return -1;", false)
    @InlineData("readonly", "return int.Parse(stored);", false)
    @InlineData("readonly", "if (other.stored != null) return int.Parse(stored); return -1;", false)
    @InlineData("readonly", "if (stored != null) return int.Parse(other.stored); return -1;", false)
    @InlineData(
        "readonly",
        "if (stored != null) { System.Func<int> f = () => int.Parse(stored); return f(); } return -1;",
        false
    )
    @InlineData("readonly", "if (stored != null) { int F() => int.Parse(stored); return F(); } return -1;", false)
    @InlineData("readonly", "if (stored != null) { goto Read; } Read: return int.Parse(stored);", false)
    @InlineData(
        "readonly",
        "if (other.stored != null) { other = this; return int.Parse(other.stored); } return -1;",
        false
    )
    @InlineData("readonly", "if (Get().stored != null) return int.Parse(Get().stored); return -1;", false)
    @InlineData("readonly", "if (Name != null) return int.Parse(Name); return -1;", false)
    @InlineData("readonly", "if (Auto != null) return int.Parse(Auto); return -1;", false)
    func GuardProof_RequiresStableReceiverAndLifetime(modifier string, body string, expected bool) {
        let source = `
#nullable enable
public class Holder {
    private MODIFIER string stored = "1";
    private static Holder Get() => new Holder();
    private string Name => stored;
    private string Auto { get; } = "1";
    public int Parse(Holder other) { BODY }
}
`.Replace("MODIFIER", modifier).Replace("BODY", body)
        let compilation = Compile(source)
        let tree = Assert.Single(compilation.SyntaxTrees)
        let model = compilation.GetSemanticModel(tree)
        let argument = Assert.Single(tree.GetRoot().DescendantNodes().OfType[ArgumentSyntax]())
        Assert.Equal(expected, ObliviousNullabilityAnalyzer.IsNullGuardDominatedRead(argument.Expression, model))
    }

    @Fact
    func OverloadedComparison_DoesNotProveAReadonlyFieldNonNull() {
        let compilation = Compile(`
#nullable enable
public class Value {
    public static bool operator ==(Value? left, Value? right) => false;
    public static bool operator !=(Value? left, Value? right) => true;
}
public class Holder {
    private readonly Value stored = new Value();
    public void Read() { if (stored != null) Consume(stored); }
    private static void Consume(Value value) { }
}
`)
        let tree = Assert.Single(compilation.SyntaxTrees)
        let model = compilation.GetSemanticModel(tree)
        let argument = Assert.Single(tree.GetRoot().DescendantNodes().OfType[ArgumentSyntax]())
        Assert.False(ObliviousNullabilityAnalyzer.IsNullGuardDominatedRead(argument.Expression, model))
    }

    @Theory
    @InlineData("readonly", "return int.Parse(stored);")
    @InlineData("", "if (stored != null) return int.Parse(stored); return -1;")
    @InlineData(
        "readonly",
        "if (stored != null) { System.Func<int> parse = () => int.Parse(stored); return parse(); } return -1;"
    )
    func IndependentlyNullableSlot_DoesNotDefeatUnsafeReadPinning(modifier string, body string) {
        let compilation = Compile(`
#nullable enable
public class Holder {
    private MODIFIER string stored;
    public Holder(string p) { stored = p; }
    public bool IsNull() => stored == null;
    public int Parse() { BODY }
    public static int Run() => new Holder(null!).Parse();
}
`.Replace("MODIFIER", modifier).Replace("BODY", body))
        let tree = Assert.Single(compilation.SyntaxTrees)
        let model = compilation.GetSemanticModel(tree)
        let parameter = Assert.Single(tree.GetRoot().DescendantNodes().OfType[ParameterSyntax]())
        Assert.False(
            ObliviousNullabilityAnalyzer.IsNullArgumentTarget(compilation, model.GetDeclaredSymbol(parameter), nil)
        )
        let document = LoadedDocument(tree.FilePath, tree, model)
        let context = TranslationContext(compilation, model, tree.FilePath)
        let printed = Cs2Gs
            .CodeModel
            .Printing
            .GSharpPrinter
            .Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("stored string?", printed)
        Assert.Contains("init(p string)", printed)
        let diagnostics = BindDiagnostics(printed).Where((diagnostic GSharpDiagnostic) -> diagnostic.IsError).ToArray()
        let error = Assert.Single(diagnostics)
        Assert.Equal("GS0154", error.Id)
        let line = printed.Split('\n').ToList().FindIndex((value string) -> value.Contains("Holder(nil)"))
        let column = printed.Split('\n')[line].IndexOf("nil", StringComparison.Ordinal)
        Assert.Equal(
            (line, column, line, column + 3),
            (
                error.Location.StartLine,
                error.Location.StartCharacter,
                error.Location.EndLine,
                error.Location.EndCharacter
            )
        )
    }

    @Theory
    @InlineData("stored = null!;")
    @InlineData("this.stored = null!;")
    @InlineData("Reset(ref stored);")
    func ConstructorWrite_InvalidatesReadonlyGuard(write string) {
        let compilation = Compile(`
#nullable enable
public class Holder {
    private readonly string stored;
    public Holder(string p) {
        stored = p;
        if (stored != null) {
            WRITE
            int.Parse(stored);
        }
    }
    private static void Reset(ref string s) { s = null!; }
}
`.Replace("WRITE", write))
        let tree = Assert.Single(compilation.SyntaxTrees)
        let model = compilation.GetSemanticModel(tree)
        let call = Assert.Single(
            tree
                .GetRoot()
                .DescendantNodes()
                .OfType[InvocationExpressionSyntax]()
                .Where((invocation InvocationExpressionSyntax) -> invocation.Expression.ToString() == "int.Parse")
        )
        Assert.False(
            ObliviousNullabilityAnalyzer.IsNullGuardDominatedRead(call.ArgumentList.Arguments[0].Expression, model)
        )
    }

    shared {
        internal func AssertClean(printed string) {
            Assert.Empty(
                BindDiagnostics(printed).Where(
                    (diagnostic GSharpDiagnostic) -> diagnostic.IsError || diagnostic.Id == "GS0536"
                )
            )
        }

        private func BindDiagnostics(printed string)[]GSharpDiagnostic {
            let tree = GSharpSyntaxTree.Parse(SourceText.From(printed, "Probe.gs"))
            using let references = ReferenceResolver.WithRuntimeReferences(nil)
            let compilation = GSharpCompilation(references, tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToArray()
        }

        private func Compile(source string) CSharpCompilation {
            let compilation = CSharpCompilation.Create(
                "Probe",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, path: "Probe.cs")},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            Assert.Empty(
                compilation.GetDiagnostics().Where(
                    (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
                )
            )
            return compilation
        }

        private func VerifyStrictIL(assembly string) {
            let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
            let references = Directory.EnumerateFiles(
                Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                "*.dll"
            )
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
