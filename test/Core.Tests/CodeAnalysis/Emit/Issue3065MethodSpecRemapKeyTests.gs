// <copyright file="Issue3065MethodSpecRemapKeyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

open class Issue3065MethodSpecRemapKeyTests {
    @Fact
    func MethodSpecSymbolKey_DifferentRemapScopes_AreNotEqual() {
        let method = typeof(Array)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single((candidate MethodInfo) -> candidate.Name == "Empty")
            .MakeGenericMethod(typeof(object))
        let typeArguments = ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        let classRemap = Dictionary[TypeParameterSymbol, int32]()
        let methodRemap = Dictionary[TypeParameterSymbol, int32]()
        let key = MetadataTokenCache.MethodSpecSymbolKey(method, typeArguments, RemapScope(classRemap, methodRemap))
        let sameScopes = MetadataTokenCache.MethodSpecSymbolKey(
            method,
            typeArguments,
            RemapScope(classRemap, methodRemap)
        )
        let differentClassScope = MetadataTokenCache.MethodSpecSymbolKey(
            method,
            typeArguments,
            RemapScope(Dictionary[TypeParameterSymbol, int32](), methodRemap)
        )
        let differentMethodScope = MetadataTokenCache.MethodSpecSymbolKey(
            method,
            typeArguments,
            RemapScope(classRemap, Dictionary[TypeParameterSymbol, int32]())
        )
        Assert.Equal(key, sameScopes)
        Assert.NotEqual(key, differentClassScope)
        Assert.NotEqual(key, differentMethodScope)
    }

    @Fact
    func GenericLambdaMethodSpecs_WithDistinctRemaps_EmitRunnableAssembly() {
        let assembly = EmittedFixture.Load(Emit())
        Assert.NotEmpty(assembly.GetTypes())
        let entryPoint = Assert.IsAssignableFrom[MethodInfo](assembly.EntryPoint)
        let previousOut = Console.Out
        using let output = StringWriter()
        Console.SetOut(output)
        try {
            entryPoint.Invoke(
                nil,
                if entryPoint.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
        } finally {
            Console.SetOut(previousOut)
        }
        Assert.Equal(
            "11${Environment.NewLine}22${Environment.NewLine}",
            output.ToString().ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func GenericLambdaMethodSpecs_RepeatedCallUsesCachedRow() {
        using let peReader = PEReader(MemoryStream(Emit(RepeatedSource)))
        let metadata = peReader.GetMetadataReader()
        let emptyMethodSpecs = Enumerable
            .Range(1, metadata.GetTableRowCount(TableIndex.MethodSpec))
            .Select(
            (row int32) -> {
                let handle = MetadataTokens.MethodSpecificationHandle(row)
                return metadata.GetMethodSpecification(handle)
            }
        )
            .Count(
            (spec MethodSpecification) -> spec.Method.Kind == HandleKind.MemberReference && metadata.GetString(
                metadata.GetMemberReference(MemberReferenceHandle(spec.Method)).Name
            ) == "Empty"
        )
        Assert.Equal(2, emptyMethodSpecs)
    }

    shared {
        private const Source string = `package MsProbe
import System

func Remap[A, B](first A, value B) B {
    var outer = Array.Empty[B]()
    let f (B) -> B = (innerValue B) -> {
        var inner = Array.Empty[B]()
        return innerValue
    }
    return f(value)
}

Console.WriteLine(Remap[int32, int32](0, 11))
Console.WriteLine(Remap[int32, int32](0, 22))`

        private const RepeatedSource string = `package MsProbe
import System

func Remap[A, B](first A, value B) B {
    var outer = Array.Empty[B]()
    let f (B) -> B = (innerValue B) -> {
        var inner = Array.Empty[B]()
        var innerAgain = Array.Empty[B]()
        return innerValue
    }
    return f(value)
}

Console.WriteLine(Remap[int32, int32](0, 11))`

        private func Emit(source string = `package MsProbe
import System

func Remap[A, B](first A, value B) B {
    var outer = Array.Empty[B]()
    let f (B) -> B = (innerValue B) -> {
        var inner = Array.Empty[B]()
        return innerValue
    }
    return f(value)
}

Console.WriteLine(Remap[int32, int32](0, 11))
Console.WriteLine(Remap[int32, int32](0, 22))`)[]uint8 {
            using let peStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            let emitResult = compilation.Emit(peStream)
            Assert.True(
                emitResult.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    emitResult.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Message)
                )
            )
            return peStream.ToArray()
        }
    }
}
