// <copyright file="Issue6221FailedArgumentLayoutSemanticModelTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import CSharpCompilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation
import CSharpCompilationOptions = Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions
import CSharpParseOptions = Microsoft.CodeAnalysis.CSharp.CSharpParseOptions
import CSharpSyntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import LanguageVersion = Microsoft.CodeAnalysis.CSharp.LanguageVersion
import MetadataReference = Microsoft.CodeAnalysis.MetadataReference
import OutputKind = Microsoft.CodeAnalysis.OutputKind
import RoslynSyntaxTree = Microsoft.CodeAnalysis.SyntaxTree
import System
import System.IO
import System.Linq
import Xunit

/// Issue #6221: arguments and callees/member groups of calls whose argument list fails
/// `TryAnalyzeCallArgumentLayout` (such as GS0245 duplicate named arguments or positional arguments
/// after named arguments) answer in the semantic model without changing diagnostics.
open class Issue6221FailedArgumentLayoutSemanticModelTests {
    @Theory
    @InlineData("H(v: x, v: x)", "H")
    @InlineData("H(v: x, x)", "H")
    @InlineData("Over(v: x, v: x)", "Over")
    @InlineData("c.M(v: x, v: x)", "M")
    @InlineData("c.M(v: x, x)", "M")
    @InlineData("C.SM(v: x, v: x)", "SM")
    @InlineData("sb.Append(value: x, value: x)", "Append")
    @InlineData("Console.WriteLine(value: x, value: x)", "WriteLine")
    func FailedLayoutOnFunctionOrMethodCall_ArgumentsAndMemberGroupAnswer(callText string, calleeName string) {
        let source = CallLayoutTemplate.Replace("@@CALL", callText)
        let (model, tree, compilation) = CreateModel(source, recordMemberGroups: true)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)

        let args = Names(tree, "x")
        Assert.Equal(2, args.Length)
        for arg in args {
            let variable = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol)
            Assert.Equal("x", variable.Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
            Assert.Same(variable, model.GetSymbolInfo(arg.IdentifierToken).Symbol)
        }

        let call = LastCall(tree)
        Assert.Equal(calleeName, call.Identifier.ValueText)
        let group = model.GetMemberGroup(call)
        Assert.NotEmpty(group)
        Assert.Equal(group.ToArray(), model.GetMemberGroup(call.Identifier).ToArray())
        Assert.All(group, (s Symbol) -> Assert.Equal(calleeName, s.Name))
    }

    @Theory
    @InlineData("f(v: x, v: x)", "f", "ParameterSymbol")
    @InlineData("f(v: x, x)", "f", "ParameterSymbol")
    @InlineData("c.G(v: x, v: x)", "G", "FieldSymbol")
    @InlineData("c.G(v: x, x)", "G", "FieldSymbol")
    @InlineData("c.P(v: x, v: x)", "P", "PropertySymbol")
    @InlineData("C.SG(v: x, v: x)", "SG", "FieldSymbol")
    func FailedLayoutOnFunctionValueCall_ArgumentsAndCalleeAnswer(
        callText string,
        calleeName string,
        expectedKind string
    ) {
        let source = CallLayoutTemplate.Replace("@@CALL", callText)
        let (model, tree, compilation) = CreateModel(source, recordMemberGroups: true)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)

        let args = Names(tree, "x")
        Assert.Equal(2, args.Length)
        for arg in args {
            let variable = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol)
            Assert.Equal("x", variable.Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
        }

        let call = LastCall(tree)
        let symbol = Assert.IsAssignableFrom[Symbol](model.GetSymbolInfo(call.Identifier).Symbol)
        Assert.Equal(expectedKind, symbol.GetType().Name)
        Assert.Equal(calleeName, symbol.Name)
        Assert.Equal("(int32) -> int32", model.GetTypeInfo(call.Identifier).Type?.ToString())
        let group = model.GetMemberGroup(call.Identifier)
        let only = Assert.Single(group)
        Assert.Same(symbol, only)
    }

    @Theory
    @InlineData("C(v: x, v: x)")
    @InlineData("DataBox(v: x, v: x)")
    @InlineData("StringBuilder(capacity: x, capacity: x)")
    @InlineData("(f)(v: x, v: x)")
    func FailedLayoutOnConstructorAndIndirectCall_ArgumentsAnswer(callText string) {
        let source = CallLayoutTemplate.Replace("@@CALL", callText)
        let (model, tree, compilation) = CreateModel(source, recordMemberGroups: true)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)

        let args = Names(tree, "x")
        Assert.Equal(2, args.Length)
        for arg in args {
            let variable = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol)
            Assert.Equal("x", variable.Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
        }
    }

    @Fact
    func FailedLayoutOnNestedReceiverAndBaseAndGenericConstraintCalls_ArgumentsReceiverAndGroupAnswer() {
        let source = `package P

import GSharp.Core.Tests.CodeAnalysis
import System

open class Base {
    open func M(v int32) int32 -> v
}

class Child : Base {
    prop Self Child {
        get { return this }
    }
    override func M(v int32) int32 {
        let x = 1
        let a = base.M(v: x, v: x)
        let b = Self.M(v: x, v: x)
        return a + b
    }
}

func Gen[T IImportedParsable[T]](s string) T -> T.Parse(s: s, s: s)
`
        let (model, tree, compilation) = CreateModel(source, recordMemberGroups: true)
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        Assert.True(errors.Length == 3, string.Join(" | ", errors.Select((d Diagnostic) -> d.Id + ": " + d.ToString())))
        Assert.All(errors, (d Diagnostic) -> Assert.Equal("GS0245", d.Id))

        let xArgs = Names(tree, "x")
        Assert.Equal(4, xArgs.Length)
        for arg in xArgs {
            Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
        }
        let sArgs = Names(tree, "s")
        Assert.Equal(2, sArgs.Length)
        for arg in sArgs {
            Assert.Equal("s", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(arg).Symbol).Name)
            Assert.Same(TypeSymbol.String, model.GetTypeInfo(arg).Type)
        }

        let calls = tree.Root.DescendantNodes().OfType[CallExpressionSyntax]().ToArray()
        Assert.Equal(3, calls.Length)
        for call in calls {
            Assert.NotEmpty(model.GetMemberGroup(call))
            Assert.NotEmpty(model.GetMemberGroup(call.Identifier))
        }

        let selfName = Names(tree, "Self").Single()
        Assert.Equal("Self", Assert.IsType[PropertySymbol](model.GetSymbolInfo(selfName).Symbol).Name)
    }

    @Fact
    func Diagnostics_AreUnchangedAndExtraArgumentErrorsAreNotEmittedOnGS0245() {
        let source = `package P

import System
import System.Collections.Generic

class C {
    var G (int32) -> int32 = (v int32) -> v
    func M(v int32) int32 -> v
}

func H(v int32) int32 -> v

func F(f (int32) -> int32, c C, values List[int32]) {
    let x = 1
    let a = f(v: x, v: missingArg)
    let b = H(v: x, v: x)
    let d = c.M(v: x, v: x)
    let e = c.G(v: out var leaked int32, v: x)
    let g = values.FindAll((v int32) -> { return "s" }, match: x, match: x)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6221-diags.gs"))
        let compilation = Compilation(tree)
        compilation.RecordMemberGroups = true
        let before = compilation.GetDiagnostics().Select(Describe).ToArray()
        let model = compilation.GetSemanticModel(tree)
        for name in Names(tree, "x") {
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(name).Type)
        }
        for call in tree.Root.DescendantNodes().OfType[CallExpressionSyntax]() {
            let _ = model.GetMemberGroup(call)
            let _ = model.GetSymbolInfo(call.Identifier)
        }
        let after = compilation.GetDiagnostics().Select(Describe).ToArray()
        Assert.Equal(before, after)
        Assert.Equal(5, before.Length)
        Assert.All(before, (line string) -> Assert.StartsWith("GS0245 Error ", line))
    }

    @Fact
    func FailedLayoutOnConstructorInlineOutAndSiblingStaticCall_KeepArgumentAnswersWithoutMemberGroups() {
        let source = `package P

class Box {
    init(v int32) { }
}

class Host {
    shared {
        func H(v int32) int32 -> v
        func Caller(x int32) int32 -> H(v: x, v: x)
    }
}

func Run() {
    let b = Box(v: out var y int32, v: y)
}
`
        let (model, tree, compilation) = CreateModel(source, recordMemberGroups: false)
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        Assert.Equal(2, errors.Length)
        Assert.All(errors, (d Diagnostic) -> Assert.Equal("GS0245", d.Id))

        let xArgs = Names(tree, "x")
        Assert.Equal(2, xArgs.Length)
        for xArg in xArgs {
            Assert.Equal("x", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(xArg).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(xArg).Type)
        }

        let yArg = Assert.Single(Names(tree, "y"))
        let yRef = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(yArg).Symbol)
        Assert.Equal("y", yRef.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(yArg).Type)
        let outArg = tree.Root.DescendantNodes().OfType[RefArgumentExpressionSyntax]().Single()
        Assert.Same(yRef, model.GetSymbolInfo(outArg).Symbol)
        Assert.Equal("*int32", model.GetTypeInfo(outArg).Type?.ToString())
    }

    @Fact
    func FailedLayoutConstructorRecovery_AppliesSequentialArgumentNarrowingEffectsWithoutLeaking() {
        let source = `package P

class Box {
    init(v string?) { }
}

func Use(initial string?) {
    var s string? = initial
    if s != nil {
        let b = Box(v: (s = nil), v: s)
        let after = s
    }
}
`
        let (model, tree, compilation) = CreateModel(source)
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        Assert.Equal("GS0245", Assert.Single(errors).Id)

        let sNames = Names(tree, "s")
        Assert.Equal(3, sNames.Length)
        Assert.Equal("string?", model.GetTypeInfo(sNames[1]).Type?.ToString())
        Assert.Equal("string", model.GetTypeInfo(sNames[2]).Type?.ToString())

        let csharpSource = `namespace ClrOutCtorNs {
    public sealed class OutBox {
        public OutBox(out int y, int extra) { y = extra; }
    }
}`
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue6221ClrOutCtor")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "ClrOutCtorLib.dll")
        let csTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
        let refs = (
            (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                Array.Empty[string]()
        )
            .Where(File.Exists)
            .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
            .ToList()
        let csCompilation = CSharpCompilation.Create(
            "ClrOutCtorLib",
            []RoslynSyntaxTree{csTree},
            refs,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithModuleName("ClrOutCtorLib.dll")
        )
        if true {
            using let pe = File.Create(libraryPath)
            let emit = csCompilation.Emit(pe)
            Assert.True(emit.Success)
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let clrSource = `package P
import ClrOutCtorNs

func Run() {
    let b = OutBox(v: out var y int32, v: y)
}
`
        let clrTree = SyntaxTree.Parse(SourceText.From(clrSource, "issue6221-clr-out.gs"))
        let clrCompilation = Compilation(resolver, clrTree)
        let clrErrors = clrCompilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        Assert.Equal("GS0245", Assert.Single(clrErrors).Id)
        let clrModel = clrCompilation.GetSemanticModel(clrTree)
        let clrYArg = Assert.Single(Names(clrTree, "y"))
        let clrYRef = Assert.IsAssignableFrom[VariableSymbol](clrModel.GetSymbolInfo(clrYArg).Symbol)
        Assert.Same(TypeSymbol.Int32, clrModel.GetTypeInfo(clrYArg).Type)
        let clrOutArg = clrTree.Root.DescendantNodes().OfType[RefArgumentExpressionSyntax]().Single()
        Assert.Same(clrYRef, clrModel.GetSymbolInfo(clrOutArg).Symbol)
        Assert.Equal("*int32", clrModel.GetTypeInfo(clrOutArg).Type?.ToString())
    }

    @Fact
    func FailedLayoutWithTargetDependentBlockArguments_KeepsBlockOperandAnswersWithoutExtraDiagnostics() {
        let source = `package P

class Box {
    init(v int32) { }
    func M(v int32) int32 -> v
    shared {
        func SM(v int32) int32 -> v
    }
}

func H(v int32) int32 -> v

func Run(b Box, x int32) {
    let a = Box(v: {
        let y = x
        default
    }, v: x)
    let c = H(v: {
        let y = x
        default
    }, v: x)
    let d = b.M(v: {
        let y = x
        default
    }, v: x)
    let e = Box.SM(v: {
        let y = x
        default
    }, v: x)
}
`
        let (model, tree, compilation) = CreateModel(source, recordMemberGroups: true)
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        Assert.Equal(4, errors.Length)
        Assert.All(errors, (d Diagnostic) -> Assert.Equal("GS0245", d.Id))

        let xArgs = Names(tree, "x")
        Assert.Equal(8, xArgs.Length)
        for xArg in xArgs {
            Assert.Equal("x", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(xArg).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(xArg).Type)
        }
    }

    shared {
        private const CallLayoutTemplate string = `package P

import System
import System.Text

data class DataBox(v int32)

class C {
    var G (int32) -> int32 = (v int32) -> v
    prop P (int32) -> int32 {
        get { return (v int32) -> v }
    }
    init(v int32) { }
    func M(v int32) int32 -> v
    shared {
        var SG (int32) -> int32 = (v int32) -> v
        func SM(v int32) int32 -> v
    }
}

func H(v int32) int32 -> v

func Over(v int32) int32 -> v
func Over(v int32, w int32) int32 -> v + w

func F(f (int32) -> int32, c C, sb StringBuilder) {
    let x = 1
    let k = @@CALL
}
`

        private func CreateModel(source string, recordMemberGroups bool = false)(
            SemanticModel,
            SyntaxTree,
            Compilation
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6221.gs"))
            let compilation = Compilation(tree)
            compilation.RecordMemberGroups = recordMemberGroups
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func Describe(d Diagnostic) string -> d.Id + " " + d.Severity.ToString() +
            " " +
            d.Location.Span.ToString() +
            " " +
            d.ToString()

        private func LastCall(tree SyntaxTree) CallExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Last()

        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
            .ToArray()
    }
}
