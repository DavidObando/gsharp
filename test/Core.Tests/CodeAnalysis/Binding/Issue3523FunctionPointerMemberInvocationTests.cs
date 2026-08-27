// <copyright file="Issue3523FunctionPointerMemberInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3523: every expression whose value has a function-pointer type is
/// callable, including source fields and properties that previously fell
/// through member-method lookup to GS0159.
/// </summary>
public class Issue3523FunctionPointerMemberInvocationTests
{
    [Theory]
    [InlineData("Cdecl", CallingConvention.Cdecl)]
    [InlineData("Stdcall", CallingConvention.StdCall)]
    [InlineData("Thiscall", CallingConvention.ThisCall)]
    [InlineData("Fastcall", CallingConvention.FastCall)]
    public void UnmanagedFieldCall_BindsFieldLoadAndCallingConvention(
        string convention,
        CallingConvention expectedConvention)
    {
        var source = $$"""
            package Issue3523

            unsafe struct Dispatch {
                var Apply unmanaged[{{convention}}] (int32) -> int32
            }

            unsafe func Main() int32 {
                let dispatch = Dispatch{}
                return dispatch.Apply(41)
            }
            """;

        var program = BindWithoutErrors(source);
        var invocation = Assert.Single(CollectInvocations(program));
        var field = Assert.IsType<BoundFieldAccessExpression>(invocation.Pointer);

        Assert.Equal("Apply", field.Field.Name);
        Assert.Equal("Dispatch", field.StructType?.Name);
        Assert.False(invocation.FunctionPointerType.IsManaged);
        Assert.Equal(expectedConvention, invocation.FunctionPointerType.CallingConvention);
        Assert.Same(invocation.FunctionPointerType, field.Type);
        Assert.Single(invocation.Arguments);
        Assert.Same(TypeSymbol.Int32, invocation.Arguments[0].Type);
    }

    [Fact]
    public void ManagedPointer_AllExpressionCalleeForms_BindFunctionPointerInvocations()
    {
        const string source = """
            package Issue3523Forms

            unsafe func increment(value int32) int32 -> value + 1

            unsafe struct Dispatch {
                var Apply *func(int32) int32
                prop Handler *func(int32) int32 -> Apply

                func InvokeField(value int32) int32 -> Apply(value)
                func InvokeProperty(value int32) int32 -> Handler(value)

                shared {
                    var SharedApply *func(int32) int32
                    prop SharedHandler *func(int32) int32 -> SharedApply
                }
            }

            unsafe func invokeRef(ref pointer *func(int32) int32, value int32) int32 {
                return pointer(value)
            }

            unsafe func Main() {
                let dispatch = Dispatch{Apply: &increment}
                Dispatch.SharedApply = &increment
                let pointers = []*func(int32) int32{&increment}
                var pointer = &increment

                dispatch.Apply(1)
                dispatch.Handler(2)
                dispatch.InvokeField(3)
                dispatch.InvokeProperty(4)
                Dispatch.SharedApply(5)
                Dispatch.SharedHandler(6)
                pointers[0](7)
                (true ? dispatch.Apply : dispatch.Handler)(8)
                (dispatch.Apply)(9)
                invokeRef(ref pointer, 10)
            }
            """;

        var invocations = CollectInvocations(BindWithoutErrors(source));

        Assert.All(invocations, invocation => Assert.True(invocation.FunctionPointerType.IsManaged));
        Assert.Contains(invocations, invocation => invocation.Pointer is BoundFieldAccessExpression);
        Assert.Contains(invocations, invocation => invocation.Pointer is BoundPropertyAccessExpression);
        Assert.Contains(invocations, invocation => invocation.Pointer is BoundIndexExpression);
        Assert.Contains(invocations, invocation => invocation.Pointer is BoundConditionalExpression);
        Assert.Contains(invocations, invocation => invocation.Pointer is BoundVariableExpression);
    }

    [Fact]
    public void PointerAndDelegateMembers_KeepDistinctBoundNodes()
    {
        const string source = """
            package Issue3523Distinct

            unsafe func increment(value int32) int32 -> value + 1

            unsafe struct Mixed {
                var Pointer *func(int32) int32
                var Handler (int32) -> int32
            }

            unsafe func Main() {
                let mixed = Mixed{
                    Pointer: &increment,
                    Handler: (value int32) -> value + 2
                }
                mixed.Pointer(1)
                mixed.Handler(1)
            }
            """;

        var program = BindWithoutErrors(source);
        Assert.Single(CollectInvocations(program));

        var indirectCalls = new IndirectCallCollector();
        VisitProgram(program, indirectCalls);
        Assert.Single(indirectCalls.Calls);
        Assert.IsType<FunctionTypeSymbol>(indirectCalls.Calls[0].Target.Type);
    }

    [Fact]
    public void InterfacePropertyAndStaticField_BindFunctionPointerLoads()
    {
        const string source = """
            package Issue3523Interfaces

            interface IDispatch {
                prop Apply unmanaged[Cdecl] (int32) -> int32 { get }
            }

            unsafe struct Dispatch : IDispatch {
                var Pointer unmanaged[Cdecl] (int32) -> int32
                prop Apply unmanaged[Cdecl] (int32) -> int32 -> Pointer
            }

            interface IStaticDispatch {
                shared {
                    var Apply unmanaged[Cdecl] (int32) -> int32
                }
            }

            unsafe func invoke(dispatch IDispatch) int32 {
                return dispatch.Apply(41)
            }

            unsafe func invokeStatic() int32 {
                return IStaticDispatch.Apply(41)
            }
            """;

        var invocations = CollectInvocations(BindWithoutErrors(source));
        Assert.Equal(2, invocations.Count);

        var property = Assert.IsType<BoundPropertyAccessExpression>(
            invocations.Single(invocation => invocation.Pointer is BoundPropertyAccessExpression).Pointer);
        Assert.Null(property.StructType);
        Assert.IsType<InterfaceSymbol>(property.Receiver?.Type);

        var field = Assert.IsType<BoundFieldAccessExpression>(
            invocations.Single(invocation => invocation.Pointer is BoundFieldAccessExpression).Pointer);
        Assert.Equal("IStaticDispatch", field.InterfaceType?.Name);
        Assert.Null(field.Receiver);
    }

    [Fact]
    public void PointerMemberCall_ReportsCallDiagnostics_NotMethodLookup()
    {
        const string source = """
            package Issue3523Diagnostics

            unsafe struct Dispatch {
                var Apply unmanaged[Cdecl] (int32) -> int32
                var Value int32
            }

            unsafe func Main() {
                let dispatch = Dispatch{}
                dispatch.Apply()
                dispatch.Apply("bad")
                dispatch.Value(41)
            }
            """;

        var errors = GetErrors(source);
        Assert.Equal(
            new[] { "GS0144", "GS0155", "GS0159" },
            errors.Select(diagnostic => diagnostic.Id).ToArray());
    }

    [Fact]
    public void ManagedPointerMember_StillRequiresUnsafeContext()
    {
        const string source = """
            package Issue3523Unsafe

            struct Dispatch {
                var Apply *func(int32) int32
            }
            """;

        var error = Assert.Single(GetErrors(source));
        Assert.Equal("GS0404", error.Id);
    }

    [Fact]
    public void NullableDelegateMember_KeepsDelegateDiagnostic()
    {
        const string source = """
            package Issue3523NullableDelegate

            struct Mixed {
                var Handler ((int32) -> int32)?
            }

            func Main() {
                let mixed = Mixed{}
                mixed.Handler(1)
            }
            """;

        var error = Assert.Single(GetErrors(source));
        Assert.Equal("GS0503", error.Id);
    }

    [Fact]
    public void ManagedPointerCallsOutsideUnsafe_ReportAtEveryCallee()
    {
        const string source = """
            package Issue3523UnsafeCalls

            unsafe struct Dispatch {
                var Apply *func(int32) int32
                prop Handler *func(int32) int32 -> Apply
                var Pointers []*func(int32) int32
                shared { var SharedApply *func(int32) int32 }
            }

            open unsafe class Base {
                protected var Apply *func(int32) int32
            }

            class Derived : Base {
                func Invoke() { Apply(1) }
            }

            func Main() {
                let dispatch = Dispatch{}
                dispatch.Apply(1)
                dispatch.Handler(2)
                (dispatch.Apply)(3)
                dispatch.Pointers[0](4)
                Dispatch.SharedApply(5)
            }
            """;

        var errors = GetErrors(source);
        Assert.Equal(6, errors.Length);
        Assert.All(errors, diagnostic => Assert.Equal("GS0404", diagnostic.Id));
        Assert.Equal(
            new[]
            {
                "Apply",
                "Apply",
                "Handler",
                "(dispatch.Apply)",
                "dispatch.Pointers[0]",
                "SharedApply",
            },
            errors.Select(diagnostic => diagnostic.Location.Text.ToString(diagnostic.Location.Span)));
    }

    [Fact]
    public void UnmanagedPointerCalls_DoNotRequireUnsafeContext()
    {
        const string source = """
            package Issue3523UnmanagedCalls

            struct Dispatch {
                var Apply unmanaged[Cdecl] (int32) -> int32
                prop Handler unmanaged[Cdecl] (int32) -> int32 -> Apply
                shared { var SharedApply unmanaged[Cdecl] (int32) -> int32 }
            }

            func Main() {
                let dispatch = Dispatch{}
                dispatch.Apply(1)
                dispatch.Handler(2)
                (dispatch.Apply)(3)
                Dispatch.SharedApply(4)
            }
            """;

        _ = BindWithoutErrors(source);
    }

    [Fact]
    public void GenericStructClassAndMethodPointerSignatures_Close()
    {
        const string source = """
            package Issue3523GenericOwners

            unsafe func identity(value int32) int32 -> value
            unsafe func choose[T](pointer *func(T) T) *func(T) T -> pointer

            unsafe struct Dispatch[T] {
                var Apply *func(T) T
                prop Handler *func(T) T -> Apply
                shared { var SharedApply *func(T) T }
            }

            unsafe class Holder[T] {
                let Apply *func(T) T
                init(apply *func(T) T) { Apply = apply }
            }

            unsafe func Main() {
                let dispatch = Dispatch[int32]{Apply: &identity}
                Dispatch[int32].SharedApply = &identity
                let holder = Holder[int32](&identity)
                let selected *func(int32) int32 = choose[int32](&identity)
                let a int32 = dispatch.Apply(41)
                let b int32 = dispatch.Handler(42)
                let c int32 = Dispatch[int32].SharedApply(43)
                let d int32 = holder.Apply(44)
                let e int32 = selected(45)
            }
            """;

        var invocations = CollectInvocations(BindWithoutErrors(source));
        Assert.Equal(5, invocations.Count);
        Assert.All(
            invocations,
            invocation =>
            {
                Assert.True(invocation.FunctionPointerType.IsManaged);
                Assert.Same(TypeSymbol.Int32, Assert.Single(invocation.FunctionPointerType.ParameterTypes));
                Assert.Same(TypeSymbol.Int32, invocation.FunctionPointerType.ReturnType);
            });
    }

    [Fact]
    public void GenericInterfaceInstanceAndStaticPointerSignatures_Close()
    {
        const string source = """
            package Issue3523GenericInterface

            interface IDispatch[T] {
                prop Apply unmanaged[Cdecl] (T) -> T { get }
                shared { var SharedApply unmanaged[Cdecl] (T) -> T }
            }

            struct Dispatch[T] : IDispatch[T] {
                var Pointer unmanaged[Cdecl] (T) -> T
                prop Apply unmanaged[Cdecl] (T) -> T -> Pointer
            }

            func invoke(dispatch IDispatch[int32]) int32 {
                let first int32 = dispatch.Apply(41)
                let second int32 = IDispatch[int32].SharedApply(42)
                return first + second
            }
            """;

        var invocations = CollectInvocations(BindWithoutErrors(source));
        Assert.Equal(2, invocations.Count);
        Assert.All(
            invocations,
            invocation =>
            {
                Assert.False(invocation.FunctionPointerType.IsManaged);
                Assert.Equal(CallingConvention.Cdecl, invocation.FunctionPointerType.CallingConvention);
                Assert.Same(TypeSymbol.Int32, Assert.Single(invocation.FunctionPointerType.ParameterTypes));
                Assert.Same(TypeSymbol.Int32, invocation.FunctionPointerType.ReturnType);
            });
    }

    [Fact]
    public void GenericInterfaceMemberTypes_AreSubstitutedWithoutFlowNarrowing()
    {
        const string source = """
            package Issue3523GenericInterfaceMemberTypes

            interface IBox[T] {
                prop Value T { get; set; }
                shared { var Shared T }
            }

            interface IDerivedBox[T] : IBox[T] { }

            class IntBox : IDerivedBox[int32] {
                prop Value int32 { get; set; }
            }

            open class Animal { }
            class Dog : Animal { func Bark() string -> "woof" }
            class SmartBox { prop Pet Animal { get; init; } }

            func getBox(box IDerivedBox[int32]) IDerivedBox[int32] -> box

            func read(box IDerivedBox[int32], smart SmartBox) {
                box.Value = 1
                getBox(box).Value += 2
                let value int32 = box.Value
                IBox[int32].Shared = 4
                IBox[int32].Shared += 1
                let shared int32 = IBox[int32].Shared
                if smart.Pet is Dog {
                    smart.Pet.Bark()
                }
            }
            """;

        var program = BindWithoutErrors(source);
        var collector = new MemberAccessCollector();
        VisitProgram(program, collector);

        var genericProperties = collector.Properties
            .Where(access => access.Property.Name == "Value"
                && access.Receiver?.Type is InterfaceSymbol)
            .ToArray();
        Assert.Equal(2, genericProperties.Length);
        Assert.All(
            genericProperties,
            genericProperty =>
            {
                Assert.Same(TypeSymbol.Int32, genericProperty.SubstitutedType);
                Assert.Null(genericProperty.NarrowedType);
                Assert.Same(TypeSymbol.Int32, genericProperty.Type);
            });

        var genericAssignments = collector.Assignments
            .Where(assignment => assignment.Property.Name == "Value")
            .ToArray();
        Assert.Equal(2, genericAssignments.Length);
        Assert.All(
            genericAssignments,
            assignment =>
            {
                Assert.Same(TypeSymbol.Int32, assignment.SubstitutedType);
                Assert.Equal("IBox[int32]", assignment.InterfaceType?.Name);
                Assert.Same(TypeSymbol.Int32, assignment.Value.Type);
                Assert.Same(TypeSymbol.Int32, assignment.Type);
            });

        var genericFields = collector.Fields
            .Where(access => access.Field.Name == "Shared"
                && access.InterfaceType != null)
            .ToArray();
        Assert.Equal(2, genericFields.Length);
        Assert.All(
            genericFields,
            genericField =>
            {
                Assert.Same(TypeSymbol.Int32, genericField.SubstitutedType);
                Assert.Null(genericField.NarrowedType);
                Assert.Same(TypeSymbol.Int32, genericField.Type);
            });

        var genericFieldAssignments = collector.FieldAssignments
            .Where(assignment => assignment.Field.Name == "Shared")
            .ToArray();
        Assert.Equal(2, genericFieldAssignments.Length);
        Assert.All(
            genericFieldAssignments,
            assignment =>
            {
                Assert.Equal("IBox[int32]", assignment.InterfaceType?.Name);
                Assert.Same(TypeSymbol.Int32, assignment.ResultType);
                Assert.Same(TypeSymbol.Int32, assignment.Value.Type);
                Assert.Same(TypeSymbol.Int32, assignment.Type);
            });

        var narrowedProperty = Assert.Single(
            collector.Properties,
            access => access.Property.Name == "Pet"
                && access.NarrowedType is StructSymbol { Name: "Dog" });
        Assert.Null(narrowedProperty.SubstitutedType);
    }

    [Fact]
    public void GenericInterfaceWrites_BindValuesAgainstClosedTypes()
    {
        const string source = """
            package Issue3523GenericInterfaceWriteDiagnostics

            interface IBox[T] {
                prop Value T { get; set; }
                shared { var Shared T }
            }

            func bad(box IBox[int32]) {
                box.Value = "bad"
                IBox[int32].Shared = "bad"
            }
            """;

        var errors = GetErrors(source);
        Assert.Equal(2, errors.Length);
        Assert.All(
            errors,
            diagnostic =>
            {
                Assert.Equal("GS0155", diagnostic.Id);
                Assert.Contains("string", diagnostic.Message);
                Assert.Contains("int32", diagnostic.Message);
            });
    }

    [Fact]
    public void ClosedGenericPointerMembers_RejectWrongArgumentTypes()
    {
        const string source = """
            package Issue3523GenericDiagnostics

            unsafe func identity(value int32) int32 -> value

            unsafe struct Dispatch[T] {
                var Apply *func(T) T
                prop Handler *func(T) T -> Apply
                shared { var SharedApply *func(T) T }
            }

            interface IDispatch[T] {
                prop Apply unmanaged[Cdecl] (T) -> T { get }
                shared { var SharedApply unmanaged[Cdecl] (T) -> T }
            }

            unsafe func bad(dispatch Dispatch[int32], iface IDispatch[int32]) {
                dispatch.Apply("bad")
                dispatch.Handler("bad")
                Dispatch[int32].SharedApply("bad")
                iface.Apply("bad")
                IDispatch[int32].SharedApply("bad")
            }
            """;

        var errors = GetErrors(source);
        Assert.Equal(5, errors.Length);
        Assert.All(
            errors,
            diagnostic =>
            {
                Assert.Equal("GS0155", diagnostic.Id);
                Assert.Contains("string", diagnostic.Message);
                Assert.Contains("int32", diagnostic.Message);
            });
    }

    [Fact]
    public void PointerSubstitution_PreservesAbiAndByRefShapes()
    {
        var parameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>
        {
            [parameter] = TypeSymbol.Int32,
        };
        var parameterTypes = ImmutableArray.Create<TypeSymbol>(
            ByRefTypeSymbol.Get(parameter));

        var managed = FunctionPointerTypeSymbol.GetManaged(
            parameterTypes,
            PointerTypeSymbol.Get(parameter));
        var unmanaged = FunctionPointerTypeSymbol.Get(
            CallingConvention.StdCall,
            parameterTypes,
            PointerTypeSymbol.Get(parameter));

        var closedManaged = Assert.IsType<FunctionPointerTypeSymbol>(
            Binder.SubstituteType(managed, substitution));
        var closedUnmanaged = Assert.IsType<FunctionPointerTypeSymbol>(
            Binder.SubstituteType(unmanaged, substitution));

        Assert.True(closedManaged.IsManaged);
        Assert.False(closedUnmanaged.IsManaged);
        Assert.Equal(CallingConvention.StdCall, closedUnmanaged.CallingConvention);
        foreach (var pointer in new[] { closedManaged, closedUnmanaged })
        {
            var byRef = Assert.IsType<ByRefTypeSymbol>(Assert.Single(pointer.ParameterTypes));
            Assert.Same(TypeSymbol.Int32, byRef.PointeeType);
            var returnPointer = Assert.IsType<PointerTypeSymbol>(pointer.ReturnType);
            Assert.Same(TypeSymbol.Int32, returnPointer.PointeeType);
        }
    }

    [Fact]
    public void PointerSubstitution_RecursesThroughEveryCompositeWrapper()
    {
        var parameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>
        {
            [parameter] = TypeSymbol.Int32,
        };
        var openPointer = FunctionPointerTypeSymbol.GetManaged(
            ImmutableArray.Create<TypeSymbol>(
                MapTypeSymbol.Get(TypeSymbol.String, parameter),
                TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(parameter, TypeSymbol.String)),
                SequenceTypeSymbol.Get(parameter),
                AsyncSequenceTypeSymbol.Get(parameter),
                ChannelTypeSymbol.Get(parameter),
                SliceTypeSymbol.Get(parameter),
                ArrayTypeSymbol.Get(parameter, 3),
                FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(parameter), parameter),
                PointerTypeSymbol.Get(parameter)),
            NullableTypeSymbol.Get(parameter));

        var closedPointer = Assert.IsType<FunctionPointerTypeSymbol>(
            Binder.SubstituteType(openPointer, substitution));

        Assert.True(closedPointer.IsManaged);
        Assert.False(TypeSymbol.AnyTypeParameter(
            closedPointer,
            candidate => ReferenceEquals(candidate, parameter)));
        Assert.IsType<MapTypeSymbol>(closedPointer.ParameterTypes[0]);
        Assert.IsType<TupleTypeSymbol>(closedPointer.ParameterTypes[1]);
        Assert.IsType<SequenceTypeSymbol>(closedPointer.ParameterTypes[2]);
        Assert.IsType<AsyncSequenceTypeSymbol>(closedPointer.ParameterTypes[3]);
        Assert.IsType<ChannelTypeSymbol>(closedPointer.ParameterTypes[4]);
        Assert.IsType<SliceTypeSymbol>(closedPointer.ParameterTypes[5]);
        Assert.IsType<ArrayTypeSymbol>(closedPointer.ParameterTypes[6]);
        Assert.IsType<FunctionTypeSymbol>(closedPointer.ParameterTypes[7]);
        Assert.IsType<PointerTypeSymbol>(closedPointer.ParameterTypes[8]);
        var nullableReturn = Assert.IsType<NullableTypeSymbol>(closedPointer.ReturnType);
        Assert.Same(TypeSymbol.Int32, nullableReturn.UnderlyingType);
    }

    [Fact]
    public void CompositeGenericPointerSignatures_CloseAcrossStructAndInterface()
    {
        const string source = """
            package Issue3523CompositePointers

            unsafe func combine(
                values map[string,int32],
                pair (int32, string),
                items sequence[int32],
                asyncItems async sequence[int32]) int32 -> 1

            async func getAsyncItems() async sequence[int32] { yield 4 }

            unsafe struct Dispatch[T] {
                var Apply *func(map[string,T], (T, string), sequence[T], async sequence[T]) T
            }

            interface IDispatch[T] {
                prop Apply unmanaged[Cdecl] (map[string,T], (T, string), sequence[T], async sequence[T]) -> T { get }
                shared {
                    var SharedApply unmanaged[Cdecl] (map[string,T], (T, string), sequence[T], async sequence[T]) -> T
                }
            }

            unsafe func invoke(dispatch Dispatch[int32], iface IDispatch[int32]) {
                let values = map[string,int32]{"x": 1}
                let pair = (2, "two")
                let items = []int32{3}
                let asyncItems = getAsyncItems()
                dispatch.Apply(values, pair, items, asyncItems)
                iface.Apply(values, pair, items, asyncItems)
                IDispatch[int32].SharedApply(values, pair, items, asyncItems)
            }
            """;

        var invocations = CollectInvocations(BindWithoutErrors(source));
        Assert.Equal(3, invocations.Count);
        Assert.All(
            invocations,
            invocation =>
            {
                Assert.Same(TypeSymbol.Int32, invocation.FunctionPointerType.ReturnType);
                Assert.Equal(4, invocation.FunctionPointerType.ParameterTypes.Length);

                var map = Assert.IsType<MapTypeSymbol>(
                    invocation.FunctionPointerType.ParameterTypes[0]);
                Assert.Same(TypeSymbol.String, map.KeyType);
                Assert.Same(TypeSymbol.Int32, map.ValueType);

                var tuple = Assert.IsType<TupleTypeSymbol>(
                    invocation.FunctionPointerType.ParameterTypes[1]);
                Assert.Same(TypeSymbol.Int32, tuple.ElementTypes[0]);
                Assert.Same(TypeSymbol.String, tuple.ElementTypes[1]);

                var sequence = Assert.IsType<SequenceTypeSymbol>(
                    invocation.FunctionPointerType.ParameterTypes[2]);
                Assert.Same(TypeSymbol.Int32, sequence.ElementType);

                var asyncSequence = Assert.IsType<AsyncSequenceTypeSymbol>(
                    invocation.FunctionPointerType.ParameterTypes[3]);
                Assert.Same(TypeSymbol.Int32, asyncSequence.ElementType);
            });
    }

    [Fact]
    public void CompositeGenericPointerCall_RejectsOpenOwnerTypesAfterConstruction()
    {
        const string source = """
            package Issue3523CompositePointerDiagnostics

            unsafe struct Dispatch[T] {
                var Apply *func(map[string,T], (T, string), sequence[T], async sequence[T]) T
            }

            async func badAsyncItems() async sequence[string] { yield "bad" }

            unsafe func bad(dispatch Dispatch[int32]) {
                dispatch.Apply(
                    map[string,string]{"x": "bad"},
                    ("bad", "pair"),
                    []string{"bad"},
                    badAsyncItems())
            }
            """;

        var errors = GetErrors(source);
        Assert.Equal(4, errors.Length);
        Assert.Equal(
            new[] { "GS0155", "GS0155", "GS0155", "GS0156" },
            errors.Select(diagnostic => diagnostic.Id));
        Assert.All(errors, diagnostic => Assert.Contains("int32", diagnostic.Message));
    }

    [Fact]
    public void CallableMembers_ApplyFieldAndGetterAccessibility()
    {
        const string source = """
            package Issue3523Accessibility

            open class Owner {
                private var PrivateField unmanaged[Cdecl] (int32) -> int32
                protected var ProtectedField unmanaged[Cdecl] (int32) -> int32
                internal var InternalField unmanaged[Cdecl] (int32) -> int32
                private var PrivateDelegate (int32) -> int32

                prop Restricted unmanaged[Cdecl] (int32) -> int32 {
                    private get -> PrivateField
                }

                func Allowed() {
                    PrivateField(1)
                    Restricted(2)
                    PrivateDelegate(3)
                }
            }

            class Derived : Owner {
                func AllowedDerived(owner Owner) {
                    owner.ProtectedField(1)
                    owner.InternalField(2)
                }
            }

            class Unrelated {
                func Denied(owner Owner) {
                    owner.PrivateField(1)
                    owner.ProtectedField(2)
                    owner.Restricted(3)
                    owner.PrivateDelegate(4)
                    owner.InternalField(5)
                }
            }

            interface IStatic {
                shared {
                    private var Hidden unmanaged[Cdecl] (int32) -> int32
                    internal var Internal unmanaged[Cdecl] (int32) -> int32
                    private func Allowed() { IStatic.Hidden(1) }
                }
            }

            func DeniedStatic() {
                IStatic.Hidden(1)
                (IStatic.Hidden)(2)
                IStatic.Internal(3)
            }
            """;

        var errors = GetErrors(source);
        Assert.Equal(
            new[] { "GS0472", "GS0379", "GS0472", "GS0472", "GS0472", "GS0472" },
            errors.Select(diagnostic => diagnostic.Id));
        Assert.Contains(errors, diagnostic => diagnostic.Message.Contains("Owner.Restricted"));
        Assert.Contains(errors, diagnostic => diagnostic.Message.Contains("Owner.PrivateDelegate"));
        Assert.Equal(2, errors.Count(diagnostic => diagnostic.Message.Contains("IStatic.Hidden")));
    }

    [Fact]
    public void BareCallableMembers_ApplyFieldAndGetterAccessibilityOnce()
    {
        const string source = """
            package Issue3523BareAccessibility

            open class Base {
                private var PrivatePointer unmanaged[Cdecl] (int32) -> int32
                private var PrivateDelegate (int32) -> int32
                private var PrivateNullable ((int32) -> int32)?
                protected var ProtectedPointer unmanaged[Cdecl] (int32) -> int32
                internal var InternalPointer unmanaged[Cdecl] (int32) -> int32

                prop Restricted unmanaged[Cdecl] (int32) -> int32 {
                    private get -> PrivatePointer
                }

                prop RestrictedDelegate (int32) -> int32 {
                    private get -> PrivateDelegate
                }

                prop Settable unmanaged[Cdecl] (int32) -> int32 {
                    private get -> PrivatePointer
                    set(value) { PrivatePointer = value }
                }

                func Allowed() {
                    PrivatePointer(1)
                    PrivateDelegate(2)
                    Restricted(3)
                    RestrictedDelegate(4)
                }
            }

            class Derived : Base {
                func Rejected() {
                    PrivatePointer(1)
                    PrivateDelegate(2)
                    PrivateNullable(3)
                    Restricted(4)
                    RestrictedDelegate(5)
                    (PrivatePointer)(6)
                    (Restricted)(7)

                    ProtectedPointer(8)
                    InternalPointer(9)
                    Settable = nil
                }
            }
            """;

        var errors = GetErrors(source);
        Assert.Equal(7, errors.Length);
        Assert.All(errors, diagnostic => Assert.Equal("GS0472", diagnostic.Id));
        Assert.Equal(
            new[]
            {
                "PrivatePointer",
                "PrivateDelegate",
                "PrivateNullable",
                "Restricted",
                "RestrictedDelegate",
                "PrivatePointer",
                "Restricted",
            },
            errors.Select(diagnostic => diagnostic.Location.Text.ToString(diagnostic.Location.Span)));
    }

    private static BoundProgram BindWithoutErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = compilation.BoundProgram;
        var errors = tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();

        Assert.True(errors.Length == 0, string.Join("; ", errors.Select(error => error.Message)));
        return program;
    }

    private static Diagnostic[] GetErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = compilation.BoundProgram;
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .GroupBy(diagnostic => new
            {
                diagnostic.Id,
                diagnostic.Location.Span.Start,
                diagnostic.Location.Span.Length,
            })
            .Select(group => group.First())
            .OrderBy(diagnostic => diagnostic.Location.Span.Start)
            .ToArray();
    }

    private static List<BoundFunctionPointerInvocationExpression> CollectInvocations(
        BoundProgram program)
    {
        var collector = new FunctionPointerInvocationCollector();
        VisitProgram(program, collector);
        return collector.Invocations;
    }

    private static void VisitProgram(BoundProgram program, BoundTreeWalker walker)
    {
        foreach (var body in program.Functions.Values)
        {
            walker.Visit(body);
        }

        walker.Visit(program.Statement);
    }

    private sealed class FunctionPointerInvocationCollector : BoundTreeWalker
    {
        public List<BoundFunctionPointerInvocationExpression> Invocations { get; } = new();

        protected override void VisitFunctionPointerInvocationExpression(
            BoundFunctionPointerInvocationExpression node)
        {
            Invocations.Add(node);
            base.VisitFunctionPointerInvocationExpression(node);
        }
    }

    private sealed class IndirectCallCollector : BoundTreeWalker
    {
        public List<BoundIndirectCallExpression> Calls { get; } = new();

        protected override void VisitIndirectCallExpression(BoundIndirectCallExpression node)
        {
            Calls.Add(node);
            base.VisitIndirectCallExpression(node);
        }
    }

    private sealed class MemberAccessCollector : BoundTreeWalker
    {
        public List<BoundFieldAccessExpression> Fields { get; } = new();

        public List<BoundFieldAssignmentExpression> FieldAssignments { get; } = new();

        public List<BoundPropertyAccessExpression> Properties { get; } = new();

        public List<BoundPropertyAssignmentExpression> Assignments { get; } = new();

        protected override void VisitFieldAccessExpression(BoundFieldAccessExpression node)
        {
            Fields.Add(node);
            base.VisitFieldAccessExpression(node);
        }

        protected override void VisitFieldAssignmentExpression(
            BoundFieldAssignmentExpression node)
        {
            FieldAssignments.Add(node);
            base.VisitFieldAssignmentExpression(node);
        }

        protected override void VisitPropertyAccessExpression(BoundPropertyAccessExpression node)
        {
            Properties.Add(node);
            base.VisitPropertyAccessExpression(node);
        }

        protected override void VisitPropertyAssignmentExpression(
            BoundPropertyAssignmentExpression node)
        {
            Assignments.Add(node);
            base.VisitPropertyAssignmentExpression(node);
        }
    }
}
