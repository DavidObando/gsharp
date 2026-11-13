// <copyright file="SymbolDisplayImportedTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Runtime.InteropServices
import System.Threading.Tasks
import Xunit

/// Hover/type display for symbols typed as imported CLR types. A constructed
/// generic such as `Task[string]` must render with its friendly G# name
/// rather than the raw assembly-qualified (cref:System.Type.FullName)
/// that (cref:TypeSymbol.Name) carries for closed generics.
open class SymbolDisplayImportedTypeTests {
    @Theory
    @InlineData("NullableReturn", "string?")
    @InlineData("ObliviousReturn", "string!")
    func Issue5492_ImportedSymbol_PreservesDeclaredReturnAnnotation(methodName string, expectedType string) {
        using let fixture = CSharpFixture(`#nullable enable
public class ImportedReturns {
    public static string? NullableReturn() => null;
#nullable disable
    public static string ObliviousReturn() => null;
}`)
        let type = fixture.Load().GetType("ImportedReturns", throwOnError: true)!!
        let method = type.GetMethod(methodName)!!
        let symbol = ImportedFunctionSymbol(methodName, ImportedClassSymbol(type, nil), method, nil)
        Assert.Equal(expectedType, SymbolDisplay.ToTypeDisplayString(symbol.Type))
        Assert.Equal(
            "func " + methodName + "() " + expectedType,
            SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature)
        )
    }

    @Fact
    func LocalVariable_OfConstructedGenericTask_RendersFriendlyName() {
        let type = ImportedTypeSymbol.Get(typeof(Task[string]))
        Assert.Equal("(local variable) v System.Threading.Tasks.Task[string]", Render(type))
    }

    @Fact
    func LocalVariable_OfNonGenericImportedType_RendersQualifiedName() {
        let type = ImportedTypeSymbol.Get(typeof(Process))
        Assert.Equal("(local variable) v System.Diagnostics.Process", Render(type))
    }

    @Fact
    func LocalVariable_OfNestedGeneric_RendersFriendlyArguments() {
        let type = ImportedTypeSymbol.Get(typeof(Dictionary[string, List[int32]]))
        Assert.Equal(
            "(local variable) v System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[int32]]",
            Render(type)
        )
    }

    @Fact
    func LocalVariable_OfNullableImportedGeneric_KeepsGSharpNullableSyntax() {
        let type = NullableTypeSymbol.Get(ImportedTypeSymbol.Get(typeof(Task[string])))
        Assert.Equal("(local variable) v System.Threading.Tasks.Task[string]?", Render(type))
    }

    @Fact
    func LocalVariable_OfSliceOfImportedGeneric_KeepsGSharpSliceSyntax() {
        let type = SliceTypeSymbol.Get(ImportedTypeSymbol.Get(typeof(Task[string])))
        Assert.Equal("(local variable) v []System.Threading.Tasks.Task[string]", Render(type))
    }

    @Fact
    func LocalVariable_OfPrimitive_RendersGSharpSpelling() {
        let type = ImportedTypeSymbol.Get(typeof(int32))
        Assert.Equal("(local variable) v int32", Render(type))
    }

    @Fact
    func LocalVariable_OfRank1ClrArray_RendersGSharpPrefixSyntax() {
        let type = ImportedTypeSymbol.Get(typeof([]int32))
        Assert.Equal("(local variable) v []int32", Render(type))
    }

    @Fact
    func LocalVariable_OfRank2ClrArray_RendersGSharpPrefixSyntax() {
        let type = ImportedTypeSymbol.Get(typeof([,]int32))
        Assert.Equal("(local variable) v [,]int32", Render(type))
    }

    @Fact
    func Issue4950_NullableFunctionPointer_ParenthesizesUnderlyingPointer() {
        let unmanagedPtr = FunctionPointerTypeSymbol.Get(
            CallingConvention.Cdecl,
            ImmutableArray[TypeSymbol].Empty,
            TypeSymbol.Int32
        )
        let nullableUnmanaged = NullableTypeSymbol.Get(unmanagedPtr)
        Assert.Equal("(unmanaged[Cdecl] () -> int32)?", nullableUnmanaged.Name)
        Assert.Equal("(unmanaged[Cdecl] () -> int32)?", nullableUnmanaged.ToString())
        Assert.Equal("(local variable) v (unmanaged[Cdecl] () -> int32)?", Render(nullableUnmanaged))

        let managedPtr = FunctionPointerTypeSymbol.GetManaged(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32),
            TypeSymbol.Int32
        )
        let nullableManaged = NullableTypeSymbol.Get(managedPtr)
        Assert.Equal("(*func(int32) int32)?", nullableManaged.Name)
        Assert.Equal("(*func(int32) int32)?", nullableManaged.ToString())
    }

    @Fact
    func Issue4992_SymbolToString_RendersImportedAndMemberSymbolsWithoutThrowing() {
        let tree = SyntaxTree.Parse(`import System.Collections.Generic
import System.Linq
import System.Threading.Tasks
class Box {
    let Count int32 = 1
    prop Label string { get; init; }
    init() { Label = "ok" }
}
func Run() {
    let xs = List[int32]()
    let e = xs.GetEnumerator()
    let b = Enumerable.Empty[Box]().First()
    let t = Task.FromResult[Box](b)
}`)
        let compilation = Compilation(tree)
        let model = compilation.GetSemanticModel(tree)
        let accessors = tree.Root.DescendantNodesAndSelf().OfType[AccessorExpressionSyntax]().ToArray()
        let symbol = model.GetSymbolInfo(accessors[0]).Symbol!!
        Assert.Equal(SymbolKind.ImportedFunction, symbol.Kind)
        Assert.Contains("func GetEnumerator()", "$symbol")
        Assert.Contains(
            "func (System.Collections.Generic.List[int32]) GetEnumerator()",
            SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Hover)
        )

        let firstSymbol = model.GetSymbolInfo(accessors[2]).Symbol!!
        Assert.Equal(SymbolKind.ImportedFunction, firstSymbol.Kind)
        Assert.EndsWith("Box", "$firstSymbol")
        Assert.EndsWith("Box", SymbolDisplay.ToDisplayString(firstSymbol, SymbolDisplayFormat.Hover))

        let fromResultSymbol = model.GetSymbolInfo(accessors[3]).Symbol!!
        Assert.Equal(SymbolKind.ImportedFunction, fromResultSymbol.Kind)
        Assert.EndsWith("System.Threading.Tasks.Task[Box]", "$fromResultSymbol")

        let importedClass = ImportedClassSymbol(typeof(List[int32]), nil)
        Assert.Equal("System.Collections.Generic.List[int32]", importedClass.ToString())

        let box = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Box")
        let field = box.Fields.Single((f FieldSymbol) -> f.Name == "Count")
        let prop = box.Properties.Single((p PropertySymbol) -> p.Name == "Label")
        Assert.Equal("let Count int32", field.ToString())
        Assert.Equal("prop Label string", prop.ToString())
    }

    @Fact
    func Issue5001_ImportedStructConstrainedGetValueOrDefaultExtension_WinsOnNarrowedSourceValueTypes() {
        using let fixture = CSharpFixture(
            "namespace ExtContract { public static class StructExt { public static int GetValueOrDefault<T>(this T value) where T : struct => 777; public static async System.Threading.Tasks.Task<T> EchoAsync<T>(T value) { await System.Threading.Tasks.Task.Yield(); return value; } } }"
        )
        let tree = SyntaxTree.Parse(`import ExtContract
struct Point {
    var X int32
}
enum Color { Red, Green }
func guardedStruct(p Point?) int32 -> p != nil ? p.GetValueOrDefault() : -1
func guardedEnum(c Color?) int32 -> c != nil ? c.GetValueOrDefault() : -1
func guardedGeneric[T struct](x T?) int32 -> x != nil ? x.GetValueOrDefault() : -1
func unguardedStruct(p Point?) int32 -> p.GetValueOrDefault().X
func echoPoint(p Point) {
    let t = StructExt.EchoAsync[Point](p)
}
`)
        let compilation = Compilation(fixture.RuntimeReferences(), tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.Empty(result.Diagnostics)
        let model = compilation.GetSemanticModel(tree)
        let echoAccessor = tree.Root.DescendantNodesAndSelf().OfType[AccessorExpressionSyntax]().Last()
        let echoSymbol = model.GetSymbolInfo(echoAccessor).Symbol!!
        let echoHover = SymbolDisplay.ToDisplayString(echoSymbol, SymbolDisplayFormat.Hover)
        Assert.StartsWith("async func ", echoHover)
        Assert.EndsWith("Point", echoHover)

        using let uninferableFixture = CSharpFixture(
            "namespace UninferableContract { public static class BadExt { public static int GetValueOrDefault<T, U>(this T value) where T : struct => 999; } }"
        )
        let fallbackTree = SyntaxTree.Parse(`import UninferableContract
struct Point {
    var X int32
}
func guardedFallback(p Point?) int32 -> p != nil ? p.GetValueOrDefault().X : -1
`)
        let fallbackCompilation = Compilation(uninferableFixture.RuntimeReferences(), fallbackTree)
        using let fallbackStream = MemoryStream()
        let fallbackResult = fallbackCompilation.Emit(fallbackStream)
        Assert.Empty(fallbackResult.Diagnostics)
    }

    shared {
        private func Render(type TypeSymbol) string {
            let local = LocalVariableSymbol("v", isReadOnly: true, type)
            return SymbolDisplay.ToDisplayString(local, SymbolDisplayFormat.Hover)
        }
    }
}
