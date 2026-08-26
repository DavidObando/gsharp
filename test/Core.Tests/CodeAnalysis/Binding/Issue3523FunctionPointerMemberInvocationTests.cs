// <copyright file="Issue3523FunctionPointerMemberInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
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
}
