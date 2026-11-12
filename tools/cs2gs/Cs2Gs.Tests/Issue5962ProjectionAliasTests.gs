// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

open class Issue5962ProjectionAliasTests {
    @Fact
    func NestedArrayAliasesQueriesLambdasAndAssignmentCycles_PreserveRuntimeAndAssertions() {
        let source = File.ReadAllText(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5962ProjectionAliases.cs.txt")
        )
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                GoldenFile.AssertMatches(
                    Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5962ProjectionAliases.golden"),
                    printed
                )
                Assert.Contains("rows[0]!!.Name", printed)
            },
            verifyAssembly: (assembly string) -> {
                let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
                for reference in Directory.EnumerateFiles(
                    Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                    "*.dll"
                ) {
                    arguments.Add("-r")
                    arguments.Add(reference)
                }
                let result = ProcessRunner.Run("dotnet", arguments, IlVerifyRunner().RepoRoot)
                Assert.False(result.TimedOut, result.Output)
                Assert.True(result.ExitCode == 0, result.Output)
            }
        )
    }

    @Theory
    @InlineData("parameter")
    @InlineData("query")
    @InlineData("local")
    @InlineData("rejected-local")
    @InlineData("in-progress")
    func RawTerminal_RechecksLiveProjectionBoundaries(boundary string) {
        let (visitor, state, document) = CreateProbe(`
#nullable enable
public static class P {
    public static object[] Run(object[] input) {
        var a = input;
        var b = a;
        return b;
    }
}`)
        let root = document.SyntaxTree.GetRoot()
        let value = Assert.Single(root.DescendantNodes().OfType[ReturnStatementSyntax]()).Expression!!
        let a = Assert.IsAssignableFrom[ILocalSymbol](
            document.SemanticModel.GetDeclaredSymbol(root.DescendantNodes().OfType[VariableDeclaratorSyntax]().First())
        )
        let input = Assert.IsAssignableFrom[IParameterSymbol](
            document.SemanticModel.GetDeclaredSymbol(Assert.Single(root.DescendantNodes().OfType[ParameterSyntax]()))
        )
        let projected = document
            .SemanticModel
            .Compilation
            .CreateArrayTypeSymbol(
            document.SemanticModel.Compilation.GetSpecialType(SpecialType.System_Object),
            1,
            NullableAnnotation.Annotated
        )
        Assert.Null(Query(visitor, value))
        if boundary == "parameter" || boundary is "rejected-local" or "in-progress" {
            state.ProjectedCallableParameterType[input] = projected
        }
        if boundary == "query" {
            state.ProjectedQueryBindingType[a] = projected
        } else if boundary == "local" {
            state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[a] = projected
        } else if boundary == "rejected-local" {
            state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[a] = nil
        } else if boundary == "in-progress" {
            state.ManagedReferenceArrayProjectedLocalTypeInProgress.Add(a)
        }
        if boundary is "rejected-local" or "in-progress" {
            Assert.Null(Query(visitor, value))
        } else {
            Assert.True(SymbolEqualityComparer.IncludeNullability.Equals(projected, Query(visitor, value)))
        }
        state.ProjectedQueryBindingType.Clear()
        state.ProjectedCallableParameterType.Clear()
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType.Clear()
        state.ManagedReferenceArrayProjectedLocalTypeInProgress.Clear()
        Assert.Null(Query(visitor, value))
    }

    @Fact
    func RawTerminal_RechecksAssignmentsInTheCurrentBodyScope() {
        let (visitor, state, document) = CreateProbe(`
#nullable enable
using System.Collections.Generic;
public static class P {
    public static List<object[]> Run(List<object[]> input) {
        var a = input;
        a = new List<object[]>();
        var b = a;
        return b;
    }
}`)
        let root = document.SyntaxTree.GetRoot()
        let method = Assert.Single(root.DescendantNodes().OfType[MethodDeclarationSyntax]())
        let value = Assert.Single(root.DescendantNodes().OfType[ReturnStatementSyntax]()).Expression!!
        let input = Assert.IsAssignableFrom[IParameterSymbol](
            document.SemanticModel.GetDeclaredSymbol(Assert.Single(root.DescendantNodes().OfType[ParameterSyntax]()))
        )
        let compilation = document.SemanticModel.Compilation
        let projected = compilation.GetTypeByMetadataName("System.Collections.Generic.List`1")!!.Construct(
            compilation.CreateArrayTypeSymbol(
                compilation.GetSpecialType(SpecialType.System_Object),
                1,
                NullableAnnotation.Annotated
            )
        )
        Assert.Null(Query(visitor, value))
        state.ProjectedCallableParameterType[input] = projected
        Assert.True(SymbolEqualityComparer.IncludeNullability.Equals(projected, Query(visitor, value)))
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType.Clear()
        state.CurrentBodyScope = method.Body
        Assert.Null(Query(visitor, value))
    }

    shared {
        private func Query(visitor object, value ExpressionSyntax) ITypeSymbol? {
            let query = Assert.IsAssignableFrom[MethodInfo](
                visitor.GetType().GetMethod(
                    "GetManagedReferenceArrayProjectedInitializerType",
                    BindingFlags.Instance | BindingFlags.NonPublic
                )
            )
            return query.Invoke(visitor, []object{value}) as ITypeSymbol
        }

        private func CreateProbe(source string)(object, DocumentTranslationState, LoadedDocument) {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Aliases.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let visitorType = Assert.IsAssignableFrom[Type](
                typeof(CSharpToGSharpTranslator).GetNestedType("DeclarationVisitor", BindingFlags.NonPublic)
            )
            let constructor = Assert.Single(
                visitorType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            )
            let arguments = constructor
                .GetParameters()
                .Select(
                (parameter ParameterInfo) -> if parameter.HasDefaultValue {
                    parameter.DefaultValue
                } else {
                    nil
                }
            )
                .ToArray()
            arguments[0] = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            arguments[1] = CSharpTypeMapper()
            let visitor = constructor.Invoke(arguments)
            let stateField = Assert.IsAssignableFrom[FieldInfo](
                visitorType.GetField("state", BindingFlags.Instance | BindingFlags.NonPublic)
            )
            return (visitor, Assert.IsType[DocumentTranslationState](stateField.GetValue(visitor)), document)
        }
    }
}
