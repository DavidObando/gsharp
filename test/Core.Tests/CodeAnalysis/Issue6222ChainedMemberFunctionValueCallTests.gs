// <copyright file="Issue6222ChainedMemberFunctionValueCallTests.gs" company="GSharp">
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

/// Issue #6222: a call through a member function value in the middle of an accessor chain
/// (`c.G(x).ToString()`) answers on its call node in `GetSymbolInfo` and `GetTypeInfo`, as it
/// does at the end of an expression (`c.G(x)`).
open class Issue6222ChainedMemberFunctionValueCallTests {
    @Theory
    @InlineData("c.G(x).ToString()", "G", "FieldSymbol")
    @InlineData("c.P(x).ToString()", "P", "PropertySymbol")
    @InlineData("c.H(x).ToString()", "H", "FieldSymbol")
    @InlineData("C.SG(x).ToString()", "SG", "FieldSymbol")
    @InlineData("C.SP(x).ToString()", "SP", "PropertySymbol")
    func CallThroughMemberFunctionValueInMiddleOfChain_CallNodeAnswersMemberAndReturnType(
        expression string,
        memberName string,
        expectedSymbolKind string
    ) {
        let source = MemberChainTemplate.Replace("@@EXPR", expression)
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())
        let call = Calls(tree, memberName).Single()
        let symbol = Assert.IsAssignableFrom[Symbol](model.GetSymbolInfo(call).Symbol)
        Assert.Equal(expectedSymbolKind, symbol.GetType().Name)
        Assert.Equal(memberName, symbol.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(call).Type)

        let calleeSymbol = Assert.IsAssignableFrom[Symbol](model.GetSymbolInfo(call.Identifier).Symbol)
        Assert.Same(symbol, calleeSymbol)
        Assert.NotNull(model.GetTypeInfo(call.Identifier).Type)

        let toStringCall = Calls(tree, "ToString").Single()
        Assert.Equal("ToString", Assert.IsType[ImportedFunctionSymbol](model.GetSymbolInfo(toStringCall).Symbol).Name)
        Assert.Same(TypeSymbol.String, model.GetTypeInfo(toStringCall).Type)

        let innerAccessor = Assert.IsType[AccessorExpressionSyntax](call.Parent)
        Assert.Same(call, innerAccessor.LeftPart)
        Assert.Equal("ToString", model.GetSymbolInfo(innerAccessor).Symbol?.Name)
        Assert.Same(TypeSymbol.String, model.GetTypeInfo(innerAccessor).Type)
    }

    @Fact
    func LongerChainThroughPropertyAndMemberFunctionValue_AllSegmentsAnswer() {
        let source = MemberChainTemplate.Replace("@@EXPR", "c.Inner.G(x).ToString()")
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())

        let gCall = Calls(tree, "G").Single()
        let gField = Assert.IsType[FieldSymbol](model.GetSymbolInfo(gCall).Symbol)
        Assert.Equal("G", gField.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(gCall).Type)
        Assert.Same(gField, model.GetSymbolInfo(gCall.Identifier).Symbol)
        Assert.Equal("(int32) -> int32", model.GetTypeInfo(gCall.Identifier).Type?.ToString())

        let innerName = Names(tree, "Inner").Single()
        let innerProp = Assert.IsType[PropertySymbol](model.GetSymbolInfo(innerName).Symbol)
        Assert.Equal("Inner", innerProp.Name)
        Assert.Equal("C", model.GetTypeInfo(innerName).Type?.Name)
        Assert.Equal("C", model.GetReceiverTypeInfo(innerName).Type?.Name)

        let cName = Names(tree, "c").Single()
        Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(cName).Symbol).Name)
        Assert.Equal("C", model.GetTypeInfo(cName).Type?.Name)

        let xName = Names(tree, "x").Single()
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(xName).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(xName).Type)
    }

    @Fact
    func LongerChainThroughClrDelegateAndFunctionPointerMembers_AllSegmentsAnswer() {
        let source = `package P

import System

unsafe class C {
    var D Func[int32, int32] = (v int32) -> v
    var Fp unmanaged[Cdecl] (int32) -> int32
    prop Inner C {
        get { return this }
    }
    init(fp unmanaged[Cdecl] (int32) -> int32) {
        Fp = fp
    }
}

unsafe func Use(c C) {
    let x = 1
    let a = c.Inner.D(x).ToString()
    let b = c.Inner.Fp(x).ToString()
}
`
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())

        let dCall = Calls(tree, "D").Single()
        Assert.Equal("Invoke", Assert.IsType[ImportedFunctionSymbol](model.GetSymbolInfo(dCall).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(dCall).Type)
        Assert.Equal("D", Assert.IsType[FieldSymbol](model.GetSymbolInfo(dCall.Identifier).Symbol).Name)

        let fpCall = Calls(tree, "Fp").Single()
        Assert.Equal("Fp", Assert.IsType[FieldSymbol](model.GetSymbolInfo(fpCall).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(fpCall).Type)

        let innerNames = Names(tree, "Inner")
        Assert.Equal(2, innerNames.Length)
        for innerName in innerNames {
            Assert.Equal("Inner", Assert.IsType[PropertySymbol](model.GetSymbolInfo(innerName).Symbol).Name)
            Assert.Equal("C", model.GetTypeInfo(innerName).Type?.Name)
            Assert.Equal("C", model.GetReceiverTypeInfo(innerName).Type?.Name)
        }
    }

    @Fact
    func ChainedExplicitInvokeAndSameNamedReturnMethod_AnswerDistinctly() {
        let source = `package P

delegate Named(v int32) int32;

class R {
    func G() int32 -> 7
}

class C {
    var G (int32) -> R = (v int32) -> R()
    var H Named = (v int32) -> v
}

func Use(c C) {
    let x = 1
    let a = c.G(x).G()
    let b = c.H.Invoke(x).ToString()
}
`
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())

        let gCalls = Calls(tree, "G")
        Assert.Equal(2, gCalls.Length)
        let fieldCall = gCalls.Single((c CallExpressionSyntax) -> c.Arguments.Count == 1)
        let methodCall = gCalls.Single((c CallExpressionSyntax) -> c.Arguments.Count == 0)

        Assert.IsType[FieldSymbol](model.GetSymbolInfo(fieldCall).Symbol)
        Assert.Equal("R", model.GetTypeInfo(fieldCall).Type?.Name)
        Assert.IsAssignableFrom[FunctionSymbol](model.GetSymbolInfo(methodCall).Symbol)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(methodCall).Type)

        let invokeCall = Calls(tree, "Invoke").Single()
        Assert.Equal("H", Assert.IsType[FieldSymbol](model.GetSymbolInfo(invokeCall).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(invokeCall).Type)
        Assert.Null(model.GetSymbolInfo(invokeCall.Identifier).Symbol)
    }

    @Fact
    func NullConditionalAndImplicitlyConvertedMemberCalls_AnswerExpectedTypes() {
        let source = MemberChainTemplate.Replace("@@EXPR", "c.G?(x)?.ToString() ?? \"\"") +
            "\nfunc UseConv(c C) []object {\n    let x = 1\n    return []object{c.G(x)}\n}\n"
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())

        let calls = Calls(tree, "G")
        Assert.Equal(2, calls.Length)
        let nullConditionalCall = calls[0]
        Assert.Equal("G", Assert.IsType[FieldSymbol](model.GetSymbolInfo(nullConditionalCall).Symbol).Name)
        Assert.Equal("int32?", model.GetTypeInfo(nullConditionalCall).Type?.ToString())

        let convertedCall = calls[1]
        Assert.Equal("G", Assert.IsType[FieldSymbol](model.GetSymbolInfo(convertedCall).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(convertedCall).Type)
        let convertedAccessor = Assert.IsType[AccessorExpressionSyntax](convertedCall.Parent)
        Assert.Equal("object", model.GetTypeInfo(convertedAccessor).Type?.ToString())
    }

    @Fact
    func NarrowedNullableFunctionPointerInChainAndNullConditionalClrDelegate_AnswerExpectedSymbols() {
        let source = `package P

import System

unsafe class Holder {
    let Fp (unmanaged[Cdecl] () -> int32)? = nil
    var D Func[int32, int32]? = nil
}

unsafe class Outer {
    let Inner Holder
    init(inner Holder) {
        Inner = inner
    }
}

unsafe func Use(o Outer, h Holder) {
    let x = 1
    if o.Inner.Fp != nil {
        let s = o.Inner.Fp().ToString()
    }
    let d = h.D?(x)?.ToString()
}
`
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())

        let fpCall = Calls(tree, "Fp").Single()
        Assert.Equal("Fp", Assert.IsType[FieldSymbol](model.GetSymbolInfo(fpCall).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(fpCall).Type)

        let innerInIf = Names(tree, "Inner").Last()
        Assert.Equal("Inner", Assert.IsType[FieldSymbol](model.GetSymbolInfo(innerInIf).Symbol).Name)
        Assert.Equal("Holder", model.GetTypeInfo(innerInIf).Type?.Name)
        Assert.Equal("Holder", model.GetReceiverTypeInfo(innerInIf).Type?.Name)

        let dCall = Calls(tree, "D").Single()
        Assert.Equal("Invoke", Assert.IsType[ImportedFunctionSymbol](model.GetSymbolInfo(dCall).Symbol).Name)
        Assert.Equal("int32?", model.GetTypeInfo(dCall).Type?.ToString())
        Assert.Equal("D", Assert.IsType[FieldSymbol](model.GetSymbolInfo(dCall.Identifier).Symbol).Name)
    }

    @Fact
    func ChainedIndexedFunctionMemberAndReferencedClrDelegateHolder_PreserveIntermediateReceiverAnswers() {
        let source = `package P

delegate Named(v int32) int32;

class Holder {
    let Fs []((int32) -> int32) = []((int32) -> int32){ (v int32) -> v }
    let Ds []Named = []Named{ (v int32) -> v }
    prop Inner Holder {
        get { return this }
    }
}

func Use(h Holder, i int32) {
    let x = 1
    let a = h.Inner.Fs[i](x).ToString()
    let b = h.Inner.Fs[0](x).ToString()
    let c = h.Inner.Ds[i].Invoke(x).ToString()
}
`
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())

        let innerNames = Names(tree, "Inner")
        Assert.Equal(3, innerNames.Length)
        for innerName in innerNames {
            Assert.Equal("Inner", Assert.IsType[PropertySymbol](model.GetSymbolInfo(innerName).Symbol).Name)
            Assert.Equal("Holder", model.GetTypeInfo(innerName).Type?.Name)
            Assert.Equal("Holder", model.GetReceiverTypeInfo(innerName).Type?.Name)
        }

        let fsIndexCall = Calls(tree, "Fs").Single()
        Assert.Equal("Fs", Assert.IsType[FieldSymbol](model.GetSymbolInfo(fsIndexCall).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(fsIndexCall).Type)
        Assert.Equal("Fs", Assert.IsType[FieldSymbol](model.GetSymbolInfo(fsIndexCall.Identifier).Symbol).Name)
        Assert.Equal("[](int32) -> int32", model.GetTypeInfo(fsIndexCall.Identifier).Type?.ToString())

        let invokeCall = Calls(tree, "Invoke").Single()
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(invokeCall).Type)

        let csharpSource = `using System;
namespace ClrHolderNs {
    public sealed class ClrInner {
        public Func<int, int> Callback = v => v;
    }
    public sealed class ClrOuter {
        public ClrInner Inner => new ClrInner();
    }
}`
        let libraryPath = EmitCSharpLibrary(csharpSource)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let clrConsumer = `package P
import ClrHolderNs

func Use(o ClrOuter) {
    let x = 1
    let s = o.Inner.Callback(x).ToString()
}
`
        let clrTree = SyntaxTree.Parse(SourceText.From(clrConsumer, "clr-holder.gs"))
        let clrCompilation = Compilation(resolver, clrTree)
        Assert.Empty(clrCompilation.GetDiagnostics())
        let clrModel = clrCompilation.GetSemanticModel(clrTree)
        let clrInner = Names(clrTree, "Inner").Single()
        Assert.Equal("Inner", Assert.IsAssignableFrom[PropertySymbol](clrModel.GetSymbolInfo(clrInner).Symbol).Name)
        Assert.Equal("ClrHolderNs.ClrInner", clrModel.GetTypeInfo(clrInner).Type?.Name)
        Assert.Equal("ClrHolderNs.ClrInner", clrModel.GetReceiverTypeInfo(clrInner).Type?.Name)
        let callbackCall = Calls(clrTree, "Callback").Single()
        Assert.Equal(
            "Callback",
            Assert.IsAssignableFrom[FieldSymbol](clrModel.GetSymbolInfo(callbackCall.Identifier).Symbol).Name
        )

        let staticSource = `package P

import System

class StaticHolder {
    shared {
        var SD Func[int32, int32] = (v int32) -> v
        let Fs []((int32) -> int32) = []((int32) -> int32){ (v int32) -> v }
    }
}

func Use(x int32, i int32) string -> StaticHolder.SD(x).ToString() + StaticHolder.Fs[i](x).ToString()
`
        let (staticModel, staticTree, staticCompilation) = CreateModel(staticSource)
        Assert.Empty(staticCompilation.GetDiagnostics())
        let qualifiers = Names(staticTree, "StaticHolder")
        Assert.Equal(2, qualifiers.Length)
        for qualifier in qualifiers {
            Assert.Equal("StaticHolder", Assert.IsType[StructSymbol](staticModel.GetSymbolInfo(qualifier).Symbol).Name)
            Assert.Null(staticModel.GetTypeInfo(qualifier).Type)
        }
        let sdCall = Calls(staticTree, "SD").Single()
        Assert.Equal("Invoke", Assert.IsType[ImportedFunctionSymbol](staticModel.GetSymbolInfo(sdCall).Symbol).Name)
        Assert.Equal("SD", Assert.IsType[FieldSymbol](staticModel.GetSymbolInfo(sdCall.Identifier).Symbol).Name)
        let staticFsCall = Calls(staticTree, "Fs").Single()
        Assert.Equal("Fs", Assert.IsType[FieldSymbol](staticModel.GetSymbolInfo(staticFsCall).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, staticModel.GetTypeInfo(staticFsCall).Type)
        Assert.Equal("Fs", Assert.IsType[FieldSymbol](staticModel.GetSymbolInfo(staticFsCall.Identifier).Symbol).Name)
    }

    shared {
        private const MemberChainTemplate string = `package P

delegate Named(v int32) int32;

class C {
    var G (int32) -> int32 = (v int32) -> v
    var H Named = (v int32) -> v
    prop P (int32) -> int32 {
        get { return (v int32) -> v }
    }
    prop Inner C {
        get { return this }
    }
    shared {
        var SG (int32) -> int32 = (v int32) -> v
        prop SP (int32) -> int32 {
            get { return (v int32) -> v }
        }
    }
}

func Use(c C) string {
    let x = 1
    return @@EXPR
}
`

        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6222.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func Calls(tree SyntaxTree, name string)[]CallExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Where((c CallExpressionSyntax) -> c.Identifier.ValueText == name)
            .ToArray()

        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
            .ToArray()

        private func EmitCSharpLibrary(csharpSource string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue6222ClrHolder")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "ClrHolderLib.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "ClrHolderLib",
                []RoslynSyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithModuleName("ClrHolderLib.dll")
            )
            using let peStream = File.Create(libraryPath)
            let emitResult = compilation.Emit(peStream)
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            return libraryPath
        }
    }
}
