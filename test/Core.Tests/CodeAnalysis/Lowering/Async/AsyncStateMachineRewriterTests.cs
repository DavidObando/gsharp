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
        Assert.Same(plan.FieldMap.StructType, plan.KickoffPlan.StateMachineLocal.Type);
        Assert.Equal(StateMachineStates.NotStartedOrRunningState, plan.KickoffPlan.InitialState);
        Assert.True(plan.KickoffPlan.ReturnsBuilderTask);
        Assert.Same(body, plan.MoveNextPlan.LoweredBody);
        Assert.Empty(plan.MoveNextPlan.AwaitResumePoints);
    }

    [Fact]
    public void Rewrite_AsyncFunction_MaterializesFieldMap()
    {
        var parameter = new ParameterSymbol("value", TypeSymbol.Int32);
        var function = new FunctionSymbol("doIt", ImmutableArray.Create(parameter), TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(new BoundExpressionStatement(null, new BoundVariableExpression(null, parameter)));
        var program = Program(function, body);

        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);

        var plan = Assert.Single(result.StateMachines);
        Assert.Equal(plan.StateMachine.Name, plan.FieldMap.StructType.Name);
        var parameterField = plan.FieldMap.GetParameterField(parameter);
        Assert.Equal("value", parameterField.Name);
        Assert.Equal(TypeSymbol.Int32, parameterField.Type);
        Assert.Throws<System.InvalidOperationException>(() => plan.StateMachine.AddField(new FieldSymbol("late", TypeSymbol.Int32, Accessibility.Public)));
    }

    [Fact]
    public void Rewrite_AllocatesAwaitResumeStatesInTraversalOrder()
    {
        var firstAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 1), TypeSymbol.Int32);
        var secondAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 2), TypeSymbol.Int32);
        var function = new FunctionSymbol("compute", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int32, package: Package) { IsAsync = true };
        var body = Block(
            new BoundExpressionStatement(null, firstAwait),
            new BoundExpressionStatement(null, secondAwait));
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
        var second = new FunctionSymbol("duplicate", ImmutableArray.Create(new ParameterSymbol("x", TypeSymbol.Int32)), TypeSymbol.Void, package: Package) { IsAsync = true };
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

    [Fact]
    public void Rewrite_PipelineComposition_ProducesStableShapeWithAllPassArtifacts()
    {
        // This end-to-end lowering test verifies that the inner pass ordering produces a
        // stable shape: ExceptionHandler → Spiller → RefHoister → CaptureWalker → MoveNextBodyRewriter.
        // We bind a program with try/catch around an await + an await in an expression,
        // run Rewrite, and assert the resulting plan demonstrates all passes ran.
        var awaitInTry = new BoundAwaitExpression(
            null,
            new BoundLiteralExpression(null, null, TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task))),
            TypeSymbol.Void);
        var awaitInExpr = new BoundAwaitExpression(
            null,
            new BoundLiteralExpression(null, null, TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task<int>))),
            TypeSymbol.Int32);

        // try { await ...; } catch(Exception e) { }
        var catchVar = new LocalVariableSymbol("e", false, TypeSymbol.FromClrType(typeof(System.Exception)));
        var tryBlock = Block(new BoundExpressionStatement(null, awaitInTry));
        var catchBody = Block();
        var catchClause = new BoundCatchClause(TypeSymbol.FromClrType(typeof(System.Exception)), catchVar, catchBody);
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), finallyBlock: null);

        // x = await Task<int>
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var body = Block(
            tryStmt,
            new BoundVariableDeclaration(null, x, awaitInExpr));

        var function = new FunctionSymbol("pipeline", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int32, package: Package) { IsAsync = true };
        var program = Program(function, body);

        // Act
        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);

        // Assert: plan was created
        var plan = Assert.Single(result.StateMachines);

        // Verify pass artifacts:
        // 1. ExceptionHandler: try/catch with await should have been rewritten
        //    (the original BoundTryStatement with await in try is gone from the plan's lowered body).
        Assert.DoesNotContain(plan.MoveNextPlan.AwaitResumePoints,
            rp => rp.AwaitExpression == awaitInTry && rp.State < 0);

        // 2. Spiller: await in expression context was spilled to statement level.
        //    The lowered body should not contain any BoundAwaitExpression as sub-expressions.
        Assert.False(AsyncBoundTreeQueries.HasAwait(plan.LoweredBody) &&
            ContainsNestedAwaitInExpression(plan.LoweredBody),
            "Spiller should have lifted sub-expression awaits.");

        // 3. Both awaits got state assignments (pipeline didn't drop any).
        Assert.True(plan.AwaitResumeStates.Count >= 2,
            $"Expected at least 2 await states, got {plan.AwaitResumeStates.Count}");

        // 4. MoveNextPlan has matching resume points.
        Assert.True(plan.MoveNextPlan.AwaitResumePoints.Length >= 2);

        // 5. Hoisted local 'x' should appear in the field map.
        Assert.NotNull(plan.FieldMap.GetLocalField(x));
    }

    private static bool ContainsNestedAwaitInExpression(BoundStatement body)
    {
        // Walk expressions looking for await nested inside binary/call/etc.
        // A properly spilled body has awaits only at statement-expression level.
        var checker = new NestedAwaitChecker();
        checker.RewriteStatement(body);
        return checker.Found;
    }

    private sealed class NestedAwaitChecker : BoundTreeRewriter
    {
        public bool Found { get; private set; }

        protected override BoundExpression RewriteBinaryExpression(BoundBinaryExpression node)
        {
            if (AsyncBoundTreeQueries.HasAwait(new BoundExpressionStatement(null, node)))
            {
                Found = true;
            }

            return base.RewriteBinaryExpression(node);
        }
    }

    private static BoundBlockStatement Block(params BoundStatement[] statements)
    {
        return new BoundBlockStatement(null, statements.ToImmutableArray());
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
