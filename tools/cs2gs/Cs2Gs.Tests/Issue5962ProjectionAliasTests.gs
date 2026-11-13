// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text
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
            verifyAssembly: VerifyStrictIL
        )
    }

    @Fact
    func QueryLambdaAliases_PreserveCapturedElementWritesAndAssertions() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
using System;
using System.Linq;
public sealed class Node { public string Name = "present"; }
public static class P {
    public static void Main() {
        var storage = new Node?[1];
        var query = from row in new[] { storage } select new Func<string>(() => {
            var a = row;
            var b = a;
            var c = b;
            Func<string> read = () => c[0] == null ? "null" : c[0]!.Name;
            ref Node? slot = ref c[0];
            slot = new Node();
            string before = read();
            slot = null;
            return before + ":" + read();
        });
        Console.Write(query.Single()());
    }
}`, verifyTranslation: (printed string) -> Assert.Contains("c[0]!!.Name", printed), verifyAssembly: VerifyStrictIL)
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
        object[] unrelated = new object[1];
        var a = input;
        var b = a;
        var c = b;
        var d = c;
        return d;
    }
}`)
        let root = document.SyntaxTree.GetRoot()
        let value = Assert.Single(root.DescendantNodes().OfType[ReturnStatementSyntax]()).Expression!!
        let a = Assert.IsAssignableFrom[ILocalSymbol](
            document.SemanticModel.GetDeclaredSymbol(
                root
                    .DescendantNodes()
                    .OfType[VariableDeclaratorSyntax]()
                    .Single((node VariableDeclaratorSyntax) -> node.Identifier.ValueText == "a")
            )
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
        let unrelated = Assert.IsAssignableFrom[ILocalSymbol](
            document.SemanticModel.GetDeclaredSymbol(root.DescendantNodes().OfType[VariableDeclaratorSyntax]().First())
        )
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[unrelated] = nil
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
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[unrelated] = nil
        Assert.Null(Query(visitor, value))
    }

    @Theory
    @InlineData("query")
    @InlineData("local")
    func RawTerminal_RechecksBoundaryValuesWithoutChangingKeys(boundary string) {
        let (visitor, state, document) = CreateProbe(`
#nullable enable
public static class P {
    public static object[] Run(object[] input) {
        object[] unrelated = new object[1];
        var x = input;
        var y = x;
        var a = y;
        var b = a;
        return b;
    }
}`)
        let declarations = document.SyntaxTree.GetRoot().DescendantNodes().OfType[VariableDeclaratorSyntax]().ToArray()
        let unrelated = Assert.IsAssignableFrom[ILocalSymbol](document.SemanticModel.GetDeclaredSymbol(declarations[0]))
        let a = Assert.IsAssignableFrom[ILocalSymbol](document.SemanticModel.GetDeclaredSymbol(declarations[3]))
        let value = declarations[4].Initializer!!.Value
        let projected = a.Type.WithNullableAnnotation(NullableAnnotation.Annotated)
        let changed = document
            .SemanticModel
            .Compilation
            .CreateArrayTypeSymbol(
            document
                .SemanticModel
                .Compilation
                .GetSpecialType(SpecialType.System_Object)
                .WithNullableAnnotation(NullableAnnotation.Annotated),
            1,
            NullableAnnotation.Annotated
        )
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[unrelated] = nil
        Assert.Null(Query(visitor, value))
        if boundary == "query" {
            state.ProjectedQueryBindingType[a] = projected
        } else {
            state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[a] = projected
        }
        Assert.True(SymbolEqualityComparer.IncludeNullability.Equals(projected, Query(visitor, value)))
        if boundary == "query" {
            state.ProjectedQueryBindingType[a] = changed
        } else {
            state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[a] = nil
            Assert.Null(Query(visitor, value))
            state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[a] = changed
        }
        Assert.True(SymbolEqualityComparer.IncludeNullability.Equals(changed, Query(visitor, value)))
        state.ProjectedQueryBindingType.Clear()
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType.Remove(a)
        Assert.Null(Query(visitor, value))
    }

    @Theory
    @InlineData("query")
    @InlineData("local")
    @InlineData("in-progress")
    func UnrelatedLiveBoundary_RawAliasWorkScalesWithSourceSize(boundary string) {
        let work = List[int64]()
        let retained = List[int64]()
        for links in[]int32{16, 128, 256, 512} {
            let source = StringBuilder(
                "#nullable enable\npublic static class P { public static T? Run<T>(T p) {\n" +
                    "object[] unrelated = new object[1];\nvar x0 = p;\n"
            )
            for var i = 1; i <= links; i++ {
                source.AppendLine("var x$i = x${i - 1};")
            }
            source.AppendLine("return x$links; } }")
            let (visitor, state, document) = CreateProbe(source.ToString())
            let declarations = document
                .SyntaxTree
                .GetRoot()
                .DescendantNodes()
                .OfType[VariableDeclaratorSyntax]()
                .ToArray()
            let unrelated = Assert.IsAssignableFrom[ILocalSymbol](
                document.SemanticModel.GetDeclaredSymbol(declarations[0])
            )
            if boundary == "query" {
                state.ProjectedQueryBindingType[unrelated] = unrelated.Type
            } else if boundary == "local" {
                state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[unrelated] = nil
            } else {
                state.ManagedReferenceArrayProjectedLocalTypeInProgress.Add(unrelated)
            }
            using let measurements = CompilationMeasurements.Start("unrelated-live-boundary")
            for declaration in declarations.Skip(1) {
                Assert.Null(Query(visitor, declaration.Initializer!!.Value))
            }
            let visits = measurements.GetCounter("translation.projection_alias_visits")
            let construction = measurements.GetCounter("translation.projection_alias_terminal_build_visits")
            let live = measurements.GetCounter("translation.projection_alias_live_boundary_visits")
            let components = measurements.GetCounter("translation.projection_alias_boundary_component_visits")
            let entries = measurements.GetCounter("translation.projection_alias_terminal_entries")
            Console.WriteLine(
                "Direct-query $boundary $links: accessors=$visits; construction=$construction; " +
                    "live=$live; components=$components; retained=$entries"
            )
            if links != 16 {
                work.Add(visits + construction + live + components)
                retained.Add(entries)
            }
        }
        Assert.True(
            work[0] > 0 && work[1] <= work[0] * 3 && work[2] <= work[1] * 3,
            "Unrelated boundaries must not force repeated chain prefixes: ${string.Join(", ", work)}."
        )
        Assert.True(
            retained[0] > 0 && retained[1] <= retained[0] * 3 && retained[2] <= retained[1] * 3,
            "Retained raw terminals must scale with source size: ${string.Join(", ", retained)}."
        )
    }

    @Fact
    func ManyUnrelatedBoundaries_DoNotReplaceShortWalksWithFullBoundaryScans() {
        let work = List[int64]()
        for count in[]int32{16, 128, 256, 512} {
            let source = StringBuilder("public static class P { public static object Run(object p) {\n")
            for var i = 0; i < count; i++ {
                source.AppendLine("object[] unrelated$i = new object[1];")
            }
            source.AppendLine("var a = p; var b = a; return b; } }")
            let (visitor, state, document) = CreateProbe(source.ToString())
            let declarations = document
                .SyntaxTree
                .GetRoot()
                .DescendantNodes()
                .OfType[VariableDeclaratorSyntax]()
                .ToArray()
            for declaration in declarations.Take(count) {
                let local = Assert.IsAssignableFrom[ILocalSymbol](document.SemanticModel.GetDeclaredSymbol(declaration))
                state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[local] = nil
            }
            let value = declarations.Last().Initializer!!.Value
            using let measurements = CompilationMeasurements.Start("short-alias-boundary-budget")
            for var i = 0; i < count; i++ {
                Assert.Null(Query(visitor, value))
            }
            let visits = measurements.GetCounter("translation.projection_alias_visits") + measurements.GetCounter(
                "translation.projection_alias_terminal_build_visits"
            ) +
                measurements.GetCounter("translation.projection_alias_live_boundary_visits") + measurements.GetCounter(
                "translation.projection_alias_boundary_component_visits"
            )
            Console.WriteLine("Direct-query short-alias $count: total-work=$visits")
            if count != 16 {
                work.Add(visits)
            }
        }
        Assert.True(
            work[0] > 0 && work[1] <= work[0] * 3 && work[2] <= work[1] * 3,
            "A short alias must not scan every live boundary: ${string.Join(", ", work)}."
        )
    }

    @Fact
    func RawTerminal_RechecksAssignmentsInTheCurrentBodyScope() {
        let (visitor, state, document) = CreateProbe(`
#nullable enable
using System.Collections.Generic;
public static class P {
    public static List<object[]> Run(List<object[]> input) {
        object[] unrelated = new object[1];
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
        let unrelated = Assert.IsAssignableFrom[ILocalSymbol](
            document.SemanticModel.GetDeclaredSymbol(root.DescendantNodes().OfType[VariableDeclaratorSyntax]().First())
        )
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[unrelated] = nil
        Assert.Null(Query(visitor, value))
        state.ProjectedCallableParameterType[input] = projected
        Assert.True(SymbolEqualityComparer.IncludeNullability.Equals(projected, Query(visitor, value)))
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType.Clear()
        state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[unrelated] = nil
        state.CurrentBodyScope = method.Body
        Assert.Null(Query(visitor, value))
    }

    shared {
        private func VerifyStrictIL(assembly string) {
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
