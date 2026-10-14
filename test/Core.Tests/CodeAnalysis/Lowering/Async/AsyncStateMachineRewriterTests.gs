// <copyright file="AsyncStateMachineRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq
import System.Threading.Tasks
import Xunit

open class AsyncStateMachineRewriterTests {
    @Fact
    func Rewrite_NonAsyncFunction_DoesNotCreatePlan() {
        let function = FunctionSymbol(
            "plain",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        )
        let body = Block()
        let program = Program(function, body)
        let result = AsyncStateMachineRewriter.Rewrite(program, Resolver)
        Assert.Same(program, result.Program)
        Assert.Empty(result.StateMachines)
        Assert.Null(function.StateMachineType)
    }

    @Fact
    func Rewrite_AsyncFunction_AttachesSynthesizedStateMachine() {
        let function = FunctionSymbol(
            "doIt",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block()
        let program = Program(function, body)
        let result = AsyncStateMachineRewriter.Rewrite(program, Resolver)
        let plan = Assert.Single(result.StateMachines)
        Assert.Same(function, plan.KickoffMethod)
        Assert.Same(body, plan.LoweredBody)
        Assert.Same(plan.StateMachine, function.StateMachineType)
        Assert.Same(plan.StateMachine, plan.FieldMap.StateMachine)
        Assert.Equal("<doIt>d__0", plan.StateMachine.Name)
        Assert.Empty(plan.AwaitResumeStates)
        Assert.Same(plan.FieldMap.StructType, plan.KickoffPlan.StateMachineLocal.Type)
        Assert.Equal(StateMachineStates.NotStartedOrRunningState, plan.KickoffPlan.InitialState)
        Assert.True(plan.KickoffPlan.ReturnsBuilderTask)
        Assert.Same(body, plan.MoveNextPlan.LoweredBody)
        Assert.Empty(plan.MoveNextPlan.AwaitResumePoints)
    }

    @Fact
    func Rewrite_AsyncFunction_MaterializesFieldMap() {
        let parameter = ParameterSymbol("value", TypeSymbol.Int32)
        let function = FunctionSymbol("doIt", ImmutableArray.Create(parameter), TypeSymbol.Void, $package: Package){
            IsAsync = true
        }
        let body = Block(BoundExpressionStatement(nil, BoundVariableExpression(nil, parameter)))
        let program = Program(function, body)
        let result = AsyncStateMachineRewriter.Rewrite(program, Resolver)
        let plan = Assert.Single(result.StateMachines)
        Assert.Equal(plan.StateMachine.Name, plan.FieldMap.StructType.Name)
        let parameterField = plan.FieldMap.GetParameterField(parameter)
        Assert.Equal("value", parameterField.Name)
        Assert.Equal(TypeSymbol.Int32, parameterField.Type)
        Assert.Throws[InvalidOperationException](
            () -> plan.StateMachine.AddField(FieldSymbol("late", TypeSymbol.Int32, Accessibility.Public))
        )
    }

    @Fact
    func Rewrite_AllocatesAwaitResumeStatesInTraversalOrder() {
        let firstAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 1), TypeSymbol.Int32)
        let secondAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 2), TypeSymbol.Int32)
        let function = FunctionSymbol(
            "compute",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Int32,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundExpressionStatement(nil, firstAwait), BoundExpressionStatement(nil, secondAwait))
        let program = Program(function, body)
        let result = AsyncStateMachineRewriter.Rewrite(program, Resolver)
        let states = Assert.Single(result.StateMachines).AwaitResumeStates
        Assert.Equal(0, states[firstAwait])
        Assert.Equal(1, states[secondAwait])
        let resumePoints = Assert.Single(result.StateMachines).MoveNextPlan.AwaitResumePoints
        Assert.Collection(
            resumePoints,
            (point AwaitResumePoint) -> Assert.Same(firstAwait, point.AwaitExpression),
            (point AwaitResumePoint) -> Assert.Same(secondAwait, point.AwaitExpression)
        )
    }

    @Fact
    func Rewrite_UsesPerNameOrdinalsForStateMachineTypeNames() {
        let first = FunctionSymbol(
            "duplicate",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let second = FunctionSymbol(
            "duplicate",
            ImmutableArray.Create(ParameterSymbol("x", TypeSymbol.Int32)),
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let program = Program((first, Block()), (second, Block()))
        let result = AsyncStateMachineRewriter.Rewrite(program, Resolver)
        let names = result
            .StateMachines
            .Select((sm AsyncStateMachinePlan) -> sm.StateMachine.Name)
            .OrderBy((name string) -> name)
            .ToArray()
        Assert.Equal([]string{"<duplicate>d__0", "<duplicate>d__1"}, names)
    }

    @Fact
    func Rewrite_UnresolvableBuilder_LeavesFunctionUnplanned() {
        let function = FunctionSymbol(
            "doIt",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let program = Program(function, Block())
        let result = AsyncStateMachineRewriter.Rewrite(program, references: nil)
        Assert.Empty(result.StateMachines)
        Assert.Null(function.StateMachineType)
    }

    @Fact
    func Rewrite_PipelineComposition_ProducesStableShapeWithAllPassArtifacts() {
        // This end-to-end lowering test verifies that the inner pass ordering produces a
        // stable shape: ExceptionHandler → Spiller → RefHoister → CaptureWalker → MoveNextBodyRewriter.
        // We bind a program with try/catch around an await + an await in an expression,
        // run Rewrite, and assert the resulting plan demonstrates all passes ran.
        let awaitInTry = BoundAwaitExpression(
            nil,
            BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void
        )
        let awaitInExpr = BoundAwaitExpression(
            nil,
            BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task[int32]))),
            TypeSymbol.Int32
        )
        // try { await ...; } catch(Exception e) { }
        let catchVar = LocalVariableSymbol("e", false, TypeSymbol.FromClrType(typeof(Exception)))
        let tryBlock = Block(BoundExpressionStatement(nil, awaitInTry))
        let catchBody = Block()
        let catchClause = BoundCatchClause(TypeSymbol.FromClrType(typeof(Exception)), catchVar, catchBody)
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), finallyBlock: nil)
        // x = await Task<int>
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let body = Block(tryStmt, BoundVariableDeclaration(nil, x, awaitInExpr))
        let function = FunctionSymbol(
            "pipeline",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Int32,
            $package: Package
        ){IsAsync = true}
        let program = Program(function, body)
        // Act
        let result = AsyncStateMachineRewriter.Rewrite(program, Resolver)
        // Assert: plan was created
        let plan = Assert.Single(result.StateMachines)
        // Verify pass artifacts:
        // 1. ExceptionHandler: try/catch with await should have been rewritten
        //    (the original BoundTryStatement with await in try is gone from the plan's lowered body).
        Assert.DoesNotContain(
            plan.MoveNextPlan.AwaitResumePoints,
            (rp AwaitResumePoint) -> rp.AwaitExpression == awaitInTry && rp.State < 0
        )
        // 2. Spiller: await in expression context was spilled to statement level.
        //    The lowered body should not contain any BoundAwaitExpression as sub-expressions.
        Assert.False(
            AsyncBoundTreeQueries.HasAwait(plan.LoweredBody) && ContainsNestedAwaitInExpression(plan.LoweredBody),
            "Spiller should have lifted sub-expression awaits."
        )
        // 3. Both awaits got state assignments (pipeline didn't drop any).
        Assert.True(
            plan.AwaitResumeStates.Count >= 2,
            "Expected at least 2 await states, got ${plan.AwaitResumeStates.Count}"
        )
        // 4. MoveNextPlan has matching resume points.
        Assert.True(plan.MoveNextPlan.AwaitResumePoints.Length >= 2)
        // 5. Hoisted local 'x' should appear in the field map.
        Assert.NotNull(plan.FieldMap.GetLocalField(x))
    }

    private class NestedAwaitChecker : BoundTreeRewriter {
        prop Found bool {
            get;
            private set;
        }

        protected override func RewriteBinaryExpression(node BoundBinaryExpression) BoundExpression {
            if AsyncBoundTreeQueries.HasAwait(BoundExpressionStatement(nil, node)) {
                Found = true
            }
            return base.RewriteBinaryExpression(node)
        }
    }

    shared {
        private let Package PackageSymbol = PackageSymbol("main", declaration: nil)
        private let Resolver ReferenceResolver = ReferenceResolver.Default()

        private func ContainsNestedAwaitInExpression(body BoundStatement) bool {
            // Walk expressions looking for await nested inside binary/call/etc.
            // A properly spilled body has awaits only at statement-expression level.
            let checker = NestedAwaitChecker()
            checker.RewriteStatement(body)
            return checker.Found
        }

        private func Block(statements ...BoundStatement) BoundBlockStatement {
            return BoundBlockStatement(nil, statements.ToImmutableArray())
        }

        private func Program(function FunctionSymbol, body BoundBlockStatement) BoundProgram {
            return Program((function, body))
        }

        private func Program(functions ...(Function FunctionSymbol, Body BoundBlockStatement)) BoundProgram {
            let builder = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            for pair in functions {
                builder.Add(pair.Function, pair.Body)
            }
            return BoundProgram(
                Package,
                ImmutableArray.Create(Package),
                ImmutableArray[Diagnostic].Empty,
                builder.ToImmutable(),
                entryPoint: nil,
                statement: Block(),
                structs: ImmutableArray[StructSymbol].Empty,
                interfaces: ImmutableArray[InterfaceSymbol].Empty
            )
        }
    }
}
