// <copyright file="TypeOfNameOfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit
import Xunit.Sdk

/// Emitted-oracle coverage for type of name of.
/// Traceability: issue #143.
open class TypeOfNameOfTests {
    @Fact
    func TypeOf_Int_Resolves_To_SystemInt32() {
        let (eval, vars) = EvaluateWithVariables(`
var t = typeof(int32)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(typeof(int32), vars["t"])
    }

    @Fact
    func TypeOf_String_Resolves_To_SystemString() {
        let (eval, vars) = EvaluateWithVariables(`
var t = typeof(string)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(typeof(string), vars["t"])
    }

    @Fact
    func TypeOf_Result_Type_Is_SystemType() {
        let tree = SyntaxTree.Parse(SourceText.From("var t = typeof(int32)\n"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let variable = FindVariable(compilation, "t")
        Assert.Equal(typeof(Type), variable.Type.ClrType)
    }

    @Fact
    func TypeOf_Slice_Of_Int_Resolves_To_Int_Array() {
        let (eval, vars) = EvaluateWithVariables(`
var t = typeof([]int32)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(typeof([]int32), vars["t"])
    }

    @Fact
    func TypeOf_Nullable_Int_Resolves_To_Nullable_Int32() {
        let (eval, vars) = EvaluateWithVariables(`
var t = typeof(int32?)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(typeof(int32?), vars["t"])
    }

    @Fact
    func TypeOf_FunctionType_Resolves_To_DelegateType() {
        let (eval, vars) = EvaluateWithVariables(`
var t = typeof((object) -> void)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(typeof((object) -> void), vars["t"])
    }

    @Fact
    func NameOf_Local_Returns_Identifier() {
        let (eval, vars) = EvaluateWithVariables(`
var counter = 0
var n = nameof(counter)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal("counter", vars["n"])
    }

    @Fact
    func NameOf_Member_Access_Returns_RightmostName() {
        let (eval, vars) = EvaluateWithVariables(`
import System
var n = nameof(Console.WriteLine)
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal("WriteLine", vars["n"])
    }

    @Fact
    func NameOf_Result_Type_Is_String() {
        let tree = SyntaxTree.Parse(SourceText.From("var n = nameof(n)\n"))
        let compilation = Compilation(tree)
        let variable = FindVariable(compilation, "n")
        Assert.Same(TypeSymbol.String, variable.Type)
    }

    @Fact
    func NameOf_Rejects_Literal_Argument() {
        let tree = SyntaxTree.Parse(SourceText.From("var n = nameof(123)\n"))
        let compilation = Compilation(tree)
        let diagnostics = compilation.GlobalScope.Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0420")
    }

    @Fact
    func NameOf_Rejects_Arbitrary_Call() {
        let tree = SyntaxTree.Parse(SourceText.From(`
import System
var n = nameof(Console.WriteLine("hi"))
`))
        let compilation = Compilation(tree)
        let diagnostics = compilation.GlobalScope.Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0420")
    }

    @Fact
    func NameOf_Generic_Type_Returns_Unqualified_Name() {
        // Issue #1329: nameof of a constructed-generic type yields the bare
        // type name with the type arguments dropped (C# nameof(List<int>) -> "List").
        let (eval, vars) = EvaluateWithVariables(`
var n = nameof(List[int32])
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal("List", vars["n"])
    }

    @Fact
    func NameOf_MultiArg_Generic_Type_Returns_Unqualified_Name() {
        // Issue #1329: a multi-type-argument generic is accepted and folds to
        // the bare type name (C# nameof(Dictionary<string, int>) -> "Dictionary").
        let (eval, vars) = EvaluateWithVariables(`
var n = nameof(Dictionary[string, int32])
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal("Dictionary", vars["n"])
    }

    @Fact
    func NameOf_Nested_Generic_Type_Returns_Unqualified_Name() {
        // Issue #1329: a nested generic type argument is accepted and folds to
        // the outer type's bare name (C# nameof(List<List<int>>) -> "List").
        let (eval, vars) = EvaluateWithVariables(`
var n = nameof(List[List[int32]])
`)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal("List", vars["n"])
    }

    @Fact
    func NameOf_Generic_Type_Result_Type_Is_String() {
        let tree = SyntaxTree.Parse(SourceText.From("var n = nameof(List[int32])\n"))
        let compilation = Compilation(tree)
        let variable = FindVariable(compilation, "n")
        Assert.Same(TypeSymbol.String, variable.Type)
    }

    shared {
        private func FindVariable(compilation Compilation, name string) VariableSymbol {
            for symbol in compilation.GlobalScope.Variables {
                if symbol.Name == name {
                    return symbol
                }
            }
            throw XunitException("variable '$name' not found")
        }

        private func EvaluateWithVariables(source string)(
            Result EmittedOracleResult,
            Variables IReadOnlyDictionary[string, object?]
        ) {
            // Post-run globals read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result, result.ReadGlobals())
        }
    }
}
