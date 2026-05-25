// <copyright file="AsyncStateMachineRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class AsyncStateMachineRewriterTests
{
    private static readonly PackageSymbol Package = new PackageSymbol("main", declaration: null);
    private static readonly ReferenceResolver Resolver = ReferenceResolver.Default();

    [Fact]
    public void Rewrite_NonAsyncFunction_DoesNotCreatePlan()
    {
        var function = new FunctionSymbol("plain", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package);
        var body = Block();
        var program = Program(function, body);

        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);

        Assert.Same(program, result.Program);
        Assert.Empty(result.StateMachines);
        Assert.Null(function.StateMachineType);
    }

    [Fact]
    public void Rewrite_AsyncFunction_AttachesSynthesizedStateMachine()
    {
        var function = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block();
        var program = Program(function, body);

        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);

        var plan = Assert.Single(result.StateMachines);
        Assert.Same(function, plan.KickoffMethod);
        Assert.Same(body, plan.LoweredBody);
        Assert.Same(plan.StateMachine, function.StateMachineType);
        Assert.Same(plan.StateMachine, plan.FieldMap.StateMachine);
        Assert.Equal("<doIt>d__0", plan.StateMachine.Name);
        Assert.Empty(plan.AwaitResumeStates);
        Assert.Same(body, plan.MoveNextPlan.LoweredBody);
        Assert.Empty(plan.MoveNextPlan.AwaitResumePoints);
    }

    [Fact]
    public void Rewrite_AsyncFunction_MaterializesFieldMap()
    {
        var parameter = new ParameterSymbol("value", TypeSymbol.Int);
        var function = new FunctionSymbol("doIt", ImmutableArray.Create(parameter), TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(new BoundExpressionStatement(new BoundVariableExpression(parameter)));
        var program = Program(function, body);

        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);

        var plan = Assert.Single(result.StateMachines);
        Assert.Equal(plan.StateMachine.Name, plan.FieldMap.StructType.Name);
        var parameterField = plan.FieldMap.GetParameterField(parameter);
        Assert.Equal("value", parameterField.Name);
        Assert.Equal(TypeSymbol.Int, parameterField.Type);
        Assert.Throws<System.InvalidOperationException>(() => plan.StateMachine.AddField(new FieldSymbol("late", TypeSymbol.Int, Accessibility.Public)));
    }

    [Fact]
    public void Rewrite_AllocatesAwaitResumeStatesInTraversalOrder()
    {
        var firstAwait = new BoundAwaitExpression(new BoundLiteralExpression(1), TypeSymbol.Int);
        var secondAwait = new BoundAwaitExpression(new BoundLiteralExpression(2), TypeSymbol.Int);
        var function = new FunctionSymbol("compute", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int, package: Package) { IsAsync = true };
        var body = Block(
            new BoundExpressionStatement(firstAwait),
            new BoundExpressionStatement(secondAwait));
        var program = Program(function, body);

        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);

        var states = Assert.Single(result.StateMachines).AwaitResumeStates;
        Assert.Equal(0, states[firstAwait]);
        Assert.Equal(1, states[secondAwait]);

        var resumePoints = Assert.Single(result.StateMachines).MoveNextPlan.AwaitResumePoints;
        Assert.Collection(
            resumePoints,
            point => Assert.Same(firstAwait, point.AwaitExpression),
            point => Assert.Same(secondAwait, point.AwaitExpression));
    }

    [Fact]
    public void Rewrite_UsesPerNameOrdinalsForStateMachineTypeNames()
    {
        var first = new FunctionSymbol("duplicate", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var second = new FunctionSymbol("duplicate", ImmutableArray.Create(new ParameterSymbol("x", TypeSymbol.Int)), TypeSymbol.Void, package: Package) { IsAsync = true };
        var program = Program(
            (first, Block()),
            (second, Block()));

        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);

        var names = result.StateMachines.Select(sm => sm.StateMachine.Name).OrderBy(name => name).ToArray();
        Assert.Equal(new[] { "<duplicate>d__0", "<duplicate>d__1" }, names);
    }

    [Fact]
    public void Rewrite_UnresolvableBuilder_LeavesFunctionUnplanned()
    {
        var function = new FunctionSymbol("doIt", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var program = Program(function, Block());

        var result = AsyncStateMachineRewriter.Rewrite(program, references: null);

        Assert.Empty(result.StateMachines);
        Assert.Null(function.StateMachineType);
    }

    private static BoundBlockStatement Block(params BoundStatement[] statements)
    {
        return new BoundBlockStatement(statements.ToImmutableArray());
    }

    private static BoundProgram Program(FunctionSymbol function, BoundBlockStatement body)
    {
        return Program((function, body));
    }

    private static BoundProgram Program(params (FunctionSymbol Function, BoundBlockStatement Body)[] functions)
    {
        var builder = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        foreach (var pair in functions)
        {
            builder.Add(pair.Function, pair.Body);
        }

        return new BoundProgram(
            Package,
            ImmutableArray.Create(Package),
            ImmutableArray<Diagnostic>.Empty,
            builder.ToImmutable(),
            entryPoint: null,
            statement: Block(),
            structs: ImmutableArray<StructSymbol>.Empty,
            interfaces: ImmutableArray<InterfaceSymbol>.Empty);
    }
}
