// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

class Issue5605PatternStorageTests {
    @Theory
    @InlineData("Entry(Node p, _)")
    @InlineData("Entry { Item: Node p }")
    func MutableSwitchCaptures_BridgeStoresIntoTheirNonNullDeclarations(pattern string) {
        let source = `
#nullable disable
using System;
public class Node { public override string ToString() => "node"; }
public record Entry(Node Item, int Id);
public static class P {
    static Entry Empty() => new Entry(null, 0);
    static string Case(Entry entry) {
        switch (entry) {
            case PATTERN:
                int i;
                (p, i) = entry;
                return p.ToString() + i;
        }
        return "miss";
    }
    static int Arm(Entry entry) => entry switch {
        PATTERN => ((p, _) = entry).Item2,
        _ => -1
    };
    static void Discard(Entry entry) {
        _ = entry switch {
            PATTERN => ((p, _) = entry).Item2,
            _ => -1
        };
    }
    public static void Main() {
        var entry = new Entry(new Node(), 7);
        Discard(entry);
        Console.Write(Case(entry) + "|" + Arm(entry));
    }
}
`.Replace("PATTERN", pattern)
        var printed = ""
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (raw string) -> {
                printed = raw
            },
            verifyAssembly: VerifyStrictIL,
            nullableContextOptions: NullableContextOptions.Disable
        )
        Assert.Contains("p = pValue!!", printed)
    }

    @Fact
    func StorageRecords_KeepSameNamedPatternSymbolsSeparateAndUnknownStoresUnbridged() {
        let (visitor, document) = TranslateWithVisitor(`
#nullable disable
public class Node { }
public record Entry(Node Item, int Id);
public static class P {
    static Entry Empty() => new Entry(null, 0);
    static void Nullable(Entry entry) {
        if (entry.Item is var p) { int i; (p, i) = Empty(); }
    }
    static void NonNull(Entry entry) {
        switch (entry) {
            case Entry(Node p, _): int i; (p, i) = entry; break;
        }
    }
}
`)
        let targets = document
            .SyntaxTree
            .GetRoot()
            .DescendantNodes()
            .OfType[AssignmentExpressionSyntax]()
            .Select(
            (assignment AssignmentExpressionSyntax) -> assignment
                .Left
                .DescendantNodes()
                .OfType[IdentifierNameSyntax]()
                .First((identifier IdentifierNameSyntax) -> identifier.Identifier.ValueText == "p")
        )
            .ToArray()
        Assert.Equal(2, targets.Length)
        let consumer = Assert.IsAssignableFrom[MethodInfo](
            visitor.GetType().GetMethod(
                "ScrutineeStorageIsNullableInGSharp",
                BindingFlags.Instance | BindingFlags.NonPublic
            )
        )
        Assert.Equal(true, consumer.Invoke(visitor, []object{targets[0]}))
        Assert.Equal(false, consumer.Invoke(visitor, []object{targets[1]}))
        let stateField = Assert.IsAssignableFrom[FieldInfo](
            visitor.GetType().GetField("state", BindingFlags.Instance | BindingFlags.NonPublic)
        )
        let state = Assert.IsType[DocumentTranslationState](stateField.GetValue(visitor))
        let local = Assert.IsAssignableFrom[ILocalSymbol](document.SemanticModel.GetSymbolInfo(targets[1]).Symbol)
        Assert.True(state.EmittedLocalStorageAcceptsNil.Remove(local))
        let bridge = Assert.IsAssignableFrom[MethodInfo](
            visitor.GetType().GetMethod(
                "BridgeDeconstructedElementStore",
                BindingFlags.Instance | BindingFlags.NonPublic
            )
        )
        let value = IdentifierExpression("element")
        Assert.Same(value, bridge.Invoke(visitor, []object{targets[1], value}))
    }

    @Theory
    @InlineData("entry.Item is var p")
    @InlineData("entry.Item is Node p")
    @InlineData("entry is { Item: var p }")
    @InlineData("entry is Entry(var p, _)")
    @InlineData("entry is { Item: Node p }")
    func MaterializedNullablePatternStorage_IsVisibleToTheStorageConsumer(pattern string) {
        let source = `
#nullable disable
public class Node { }
public record Entry(Node Item, int Id);
public static class P {
    static Entry Empty() => new Entry(null, 0);
    static bool Read(Entry entry) {
        if (PATTERN) {
            int i;
            (p, i) = Empty();
            object value = p;
            return value == null;
        }
        return false;
    }
}
`.Replace("PATTERN", pattern)
        let (visitor, document) = TranslateWithVisitor(source)
        let target = document
            .SyntaxTree
            .GetRoot()
            .DescendantNodes()
            .OfType[AssignmentExpressionSyntax]()
            .Single()
            .Left
            .DescendantNodes()
            .OfType[IdentifierNameSyntax]()
            .First((identifier IdentifierNameSyntax) -> identifier.Identifier.ValueText == "p")
        let consumer = Assert.IsAssignableFrom[MethodInfo](
            visitor.GetType().GetMethod(
                "ScrutineeStorageIsNullableInGSharp",
                BindingFlags.Instance | BindingFlags.NonPublic
            )
        )
        Assert.Equal(true, consumer.Invoke(visitor, []object{target}))
    }

    @Theory
    @InlineData("entry.Item is var p")
    @InlineData("entry.Item is Node p")
    @InlineData("entry is { Item: var p }")
    @InlineData("entry is Entry(var p, _)")
    func NullablePatternDeclarations_StoreNullWithoutAnAssertion(pattern string) {
        let source = `
#nullable disable
using System;
public class Node { }
public record Entry(Node Item, int Id);
public static class P {
    static int reads;
    static Entry Empty() { reads++; return new Entry(null, 0); }
    static string Read(Entry entry) {
        if (PATTERN) {
            int i;
            (p, i) = Empty();
            object value = p;
            return (value == null) + ":" + i;
        }
        return "miss";
    }
    public static void Main() {
        Console.Write(Read(new Entry(new Node(), 7)) + "|" + reads);
    }
}
`.Replace("PATTERN", pattern)
        var printed = ""
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (raw string) -> {
                printed = raw
            },
            verifyAssembly: VerifyStrictIL,
            nullableContextOptions: NullableContextOptions.Disable
        )
        Assert.Contains("var p Node?", printed)
        Assert.DoesNotContain("p = pValue!!", printed)
    }

    shared {
        private func TranslateWithVisitor(source string)(object, LoadedDocument) {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", source)})
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
            arguments[2] = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            let visitor = constructor.Invoke(arguments)
            let syntaxVisitor = Assert.IsAssignableFrom[CSharpSyntaxVisitor[GMember]](visitor)
            for member in cast[CompilationUnitSyntax](document.SyntaxTree.GetRoot()).Members {
                syntaxVisitor.Visit(member)
            }
            return (visitor, document)
        }

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
    }
}
