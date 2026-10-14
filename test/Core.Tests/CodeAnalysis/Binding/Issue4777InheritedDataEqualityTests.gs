// <copyright file="Issue4777InheritedDataEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

open class Issue4777InheritedDataEqualityTests {
    @Theory
    @InlineData("Leaf")
    @InlineData("Root")
    func SourceObjectCallsAndMethodGroups_PreserveMostDerivedEquality(owner string) {
        let result = EmittedOracle.Evaluate((`import System
open data class Root(Tag int32)
data class Leaf(Tag int32, Extra int32) : Root(Tag)
let receiver ` + "$owner" + ` = Leaf(1, 2)
let same Object = Leaf(1, 2)
let different Object = Leaf(1, 3)
let wrong Object = Root(1)
let missing Object? = nil
let equals Func[Object?, bool] = receiver.Equals
receiver.Equals(same) && !receiver.Equals(different)
    && !receiver.Equals(wrong) && !receiver.Equals(missing)
    && receiver.Equals(obj: same)
    && equals(same) && !equals(different) && !equals(wrong) && !equals(nil)`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SourceGenericValueData_ObjectCallsAndMethodGroupsPreserveBoxedEquality() {
        let result = EmittedOracle.Evaluate(`import System
data struct Payload[T any](Value T)
let receiver = Payload[int32]{Value: 1}
let same Object = Payload[int32]{Value: 1}
let different Object = Payload[int32]{Value: 2}
let wrong Object = Payload[string]{Value: "1"}
let equals Func[Object?, bool] = receiver.Equals
receiver.Equals(same) && !receiver.Equals(different)
    && !receiver.Equals(wrong) && !receiver.Equals(nil)
    && receiver.Equals(obj: same)
    && equals(same) && !equals(different) && !equals(wrong) && !equals(nil)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SourceNestedGenericData_ObjectAndTypedMethodGroupsRetainConstructedOwner() {
        let compilation = Compilation(SyntaxTree.Parse(`package NestedCalls
import System
public class Owner[T any] {
    public open data class Root[U any](Value U)
    public data class Leaf[U any](Value U, Extra U) : Root[U](Value)
}
public func Compare(receiver Owner[int32].Root[string],
    same Owner[int32].Root[string], different Owner[int32].Root[string]) bool {
    let sameObject Object = same
    let differentObject Object = different
    let objectEquals Func[Object?, bool] = receiver.Equals
    let typedEquals Func[Owner[int32].Root[string]?, bool] = receiver.Equals
    return receiver.Equals(sameObject) && !receiver.Equals(differentObject)
        && objectEquals(same) && !objectEquals(different) && !objectEquals(nil)
        && typedEquals(same) && !typedEquals(different) && !typedEquals(nil)
}`)){IsLibrary = true}
        using let image = MemoryStream()
        let result = compilation.Emit(image)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics))
        image.Position = 0
        let context = AssemblyLoadContext(
            "SourceNestedGenericData_ObjectAndTypedMethodGroupsRetainConstructedOwner",
            isCollectible: true
        )
        try {
            let assembly = context.LoadFromStream(image)
            let leaf = assembly.GetType("NestedCalls.Owner`1+Leaf`1", throwOnError: true)!!.MakeGenericType(
                typeof(int32),
                typeof(string)
            )
            let first object? = Activator.CreateInstance(leaf, "value", "extra")
            let same object? = Activator.CreateInstance(leaf, "value", "extra")
            let different object? = Activator.CreateInstance(leaf, "value", "different")
            let compare = assembly
                .GetTypes()
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.Static)
                }
            )
                .Single((method MethodInfo) -> method.Name == "Compare")
            Assert.Equal(true, compare.Invoke(nil, []object{first, same, different}))
        } finally {
            context.Unload()
        }
    }

    @Fact
    func SourceObjectMethodGroup_UsesTheSynthesizedNullableObjectSlot() {
        let result = EmittedOracle.Evaluate(`import System
data class Payload(Value int32)
let receiver = Payload(1)
let equals Func[Object?, bool] = receiver.Equals
equals`)
        Assert.Empty(result.Diagnostics)
        let method = Assert.IsAssignableFrom[Delegate](result.Value).Method
        Assert.Equal("Payload", method.DeclaringType!!.Name)
        let parameter = Assert.Single(method.GetParameters())
        Assert.Equal(typeof(object), parameter.ParameterType)
        Assert.Equal("obj", parameter.Name)
        Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(parameter).ReadState)
        Assert.True(method.IsVirtual)
        Assert.False(method.IsFinal)
        Assert.Equal(typeof(object), method.GetBaseDefinition().DeclaringType)
    }

    @Fact
    func NativeNestedGenericData_EmitThenQueryRetainsSourceEqualityShape() {
        let compilation = Compilation(SyntaxTree.Parse(`package NativeNested
public class Outer[T any] {
    public open data class Root[U any](Value U)
    public data class Leaf[U any](Value U, Extra U) : Root[U](Value)
    public data struct Payload[U any](Value U)
}`)){IsLibrary = true}
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let dataTypes = compilation.GlobalScope.Structs.Where((s StructSymbol) -> s.IsData).ToArray()
        Assert.Equal(3, dataTypes.Length)
        Assert.All(dataTypes, (s StructSymbol) -> Assert.Single(s.TypeParameters))
        for var emission = 0; emission < 2; emission++ {
            using let image = MemoryStream()
            using let reference = MemoryStream()
            let result = compilation.Emit(image, refStream: reference)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            Assert.True(reference.Length > int64(0))
            for type in dataTypes {
                Assert.Single(type.TypeParameters)
                let methods = TypeMemberModel.GetMethods(
                    type,
                    "Equals",
                    MemberQuery(true, false, false, MemberKinds.Method)
                )
                Assert.NotEmpty(methods)
                for method in methods {
                    if method.Parameters[0].Type.StripToBareShape() == TypeSymbol.Object {
                        Assert.Equal("obj", method.Parameters[0].Name)
                        Assert.True(TypeSymbol.ContainsReferenceNullableAnnotation(method.Parameters[0].Type))
                        continue
                    }
                    let parameter = Assert.IsType[StructSymbol](
                        Assert.Single(method.Parameters).Type.StripToBareShape()
                    )
                    Assert.Single(parameter.TypeArguments)
                    Assert.Equal("U", parameter.TypeArguments[0].Name)
                }
            }
            image.Position = 0
            let context = AssemblyLoadContext(
                "NativeNestedGenericData_EmitThenQueryRetainsSourceEqualityShape",
                isCollectible: true
            )
            try {
                let assembly = context.LoadFromStream(image)
                let root = assembly.GetType("NativeNested.Outer`1+Root`1", throwOnError: true)!!.MakeGenericType(
                    typeof(int32),
                    typeof(string)
                )
                let leaf = assembly.GetType("NativeNested.Outer`1+Leaf`1", throwOnError: true)!!.MakeGenericType(
                    typeof(int32),
                    typeof(string)
                )
                let first object? = Activator.CreateInstance(leaf, "value", "extra")
                let same object? = Activator.CreateInstance(leaf, "value", "extra")
                let different object? = Activator.CreateInstance(leaf, "value", "different")
                for owner in[]Type{root, leaf} {
                    let method MethodInfo? = owner.GetMethod("Equals", []Type{owner})
                    Assert.NotNull(method)
                    Assert.Equal(false, method!!.Invoke(first, []object{different}))
                    Assert.Equal(true, method!!.Invoke(first, []object{same}))
                    Assert.Equal(false, method!!.Invoke(first, []object? {nil}))
                }
            } finally {
                context.Unload()
            }
        }
    }

    @Fact
    func SourceMemberQueriesAndCompletion_ExposeTheSameTypedSlots() {
        let compilation = Compilation(
            SyntaxTree.Parse("open data class Root(Tag int32)\ndata class Leaf(Tag int32, Extra int32) : Root(Tag)")
        ){IsLibrary = true}
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let leaf = Assert.Single(compilation.GlobalScope.Structs, (s StructSymbol) -> s.Name == "Leaf")
        let query = MemberQuery(true, false, false, MemberKinds.Method)
        let slots = leaf.GetMethods("Equals")
        Assert.Equal(3, slots.Length)
        Assert.Equal[FunctionSymbol](slots, TypeMemberModel.GetMethods(leaf, "Equals", query))
        Assert.Same(slots[0], TypeMemberModel.LookupMember(leaf, "Equals", query))
        // ADR-0199: the compiler-owned PrintMembers slot is enumerated after the
        // equality slots.
        let printMembers = Assert.Single(
            leaf.GetMembers().OfType[FunctionSymbol](),
            (m FunctionSymbol) -> m.Name == "PrintMembers"
        )
        Assert.Equal(slots.Add(printMembers), TypeMemberModel.EnumerateMembers(leaf, query).OfType[FunctionSymbol]())
        Assert.Equal(slots.Add(printMembers), leaf.GetMembers().OfType[FunctionSymbol]())
        Assert.Empty(TypeMemberModel.GetMethods(leaf, "Equals", MemberQuery.Static()))
    }

    @Fact
    func SourceNamedCallsAndMethodGroups_UseCompilerOwnedTypedSlots() {
        let result = EmittedOracle.Evaluate(`import System
open data class Root(Tag int32)
data class Leaf(Tag int32, Extra int32) : Root(Tag)
let first = Leaf(1, 2)
let different = Leaf(1, 3)
let same = Leaf(1, 2)
let root Root = first
let selfEquals Func[Leaf?, bool] = first.Equals
let baseEquals Func[Root?, bool] = root.Equals
!first.Equals(other: different)
    && first.Equals(other: same)
    && !root.Equals(other: different)
    && root.Equals(other: same)
    && !selfEquals(different) && selfEquals(same) && !selfEquals(nil)
    && !baseEquals(different) && baseEquals(same) && !baseEquals(nil)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Theory
    @InlineData("Leaf")
    @InlineData("Root")
    func SourceTypedMethodGroups_SelectTypedParameterNotObjectFallback(owner string) {
        let result = EmittedOracle.Evaluate((`import System
open data class Root(Tag int32)
data class Leaf(Tag int32, Extra int32) : Root(Tag)
let receiver ` + "$owner" + ` = Leaf(1, 2)
let equals Func[` + "$owner" + `?, bool] = receiver.Equals
equals`))
        Assert.Empty(result.Diagnostics)
        let method = Assert.IsAssignableFrom[Delegate](result.Value).Method
        let parameter = Assert.Single(method.GetParameters())
        Assert.Equal(owner, parameter.ParameterType.Name)
        Assert.Equal("other", parameter.Name)
    }

    @Fact
    func NativeClrTypedCallsWithoutInterface_CompareMostDerivedFieldsAndPreservePlainMethods() {
        let compilation = Compilation(SyntaxTree.Parse(`package NoInterface
public open data class Root(Tag int32)
public open data class Middle(Tag int32, Value int32) : Root(Tag)
public data class Leaf(Tag int32, Value int32, Extra int32) : Middle(Tag, Value)
public class Plain {
    public func Equals(other Plain?) bool -> false
}`)){IsLibrary = true}
        using let image = MemoryStream()
        let result = compilation.Emit(image)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics))
        image.Position = 0
        let context = AssemblyLoadContext("Issue4777InheritedDataEqualityTests", isCollectible: true)
        try {
            let assembly = context.LoadFromStream(image)
            let root Type? = assembly.GetType("NoInterface.Root", throwOnError: true)
            let middle Type? = assembly.GetType("NoInterface.Middle", throwOnError: true)
            let leaf Type? = assembly.GetType("NoInterface.Leaf", throwOnError: true)
            let plain Type? = assembly.GetType("NoInterface.Plain", throwOnError: true)
            // ADR-0199: a data type implements IEquatable<Self> without naming
            // it, as a C# record does; an ordinary class with an `Equals(Self)`
            // method still implements nothing.
            Assert.Equal([]Type{typeof(IEquatable[_]).MakeGenericType(root!!)}, root!!.GetInterfaces())
            Assert.Equal(
                []Type{root!!, middle!!, leaf!!}.Select((type Type) -> typeof(IEquatable[_]).MakeGenericType(type))
                    .ToHashSet(),
                leaf!!.GetInterfaces().ToHashSet()
            )
            Assert.Empty(plain!!.GetInterfaces())
            let slot MethodInfo? = middle!!.GetMethod("Equals", []Type{root!!})
            Assert.NotNull(slot)
            Assert.True(slot!!.IsVirtual)
            Assert.True(slot!!.IsFinal)
            Assert.Equal(root, slot!!.GetBaseDefinition().DeclaringType)
            let first object? = Activator.CreateInstance(leaf!!, 1, 2, 3)
            let different object? = Activator.CreateInstance(leaf!!, 1, 2, 4)
            let same object? = Activator.CreateInstance(leaf!!, 1, 2, 3)
            for owner in[]Type{root!!, middle!!, leaf!!} {
                let equals MethodInfo? = owner.GetMethod("Equals", []Type{owner})
                Assert.NotNull(equals)
                Assert.Equal(false, equals!!.Invoke(first, []object{different}))
                Assert.Equal(true, equals!!.Invoke(first, []object{same}))
                Assert.Equal(true, equals!!.Invoke(first, []object{first}))
                Assert.Equal(false, equals!!.Invoke(first, []object? {nil}))
            }
            let ordinary MethodInfo? = plain!!.GetMethod("Equals", []Type{plain!!})
            Assert.NotNull(ordinary)
            Assert.False(ordinary!!.IsVirtual)
        } finally {
            context.Unload()
        }
    }

    @Fact
    func UserAuthoredTypedBaseOverride_RemainsReserved() {
        let result = EmittedOracle.Evaluate(`open data class Root(Tag int32)
data class Leaf(Tag int32, Extra int32) : Root(Tag) {
    public override func Equals(other Root?) bool -> false
}
0`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
        Assert.Contains("Data class 'Leaf' synthesizes member 'Equals'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("class Plain : IEquatable[Plain] {}")
    @InlineData("data class Wrong(Value int32) : IEquatable[string]")
    func CompilerOwnedEquality_DoesNotSatisfyWrongOrPlainContract(declaration string) {
        let compilation = Compilation(SyntaxTree.Parse("import System\n" + declaration)){IsLibrary = true}
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }
}
