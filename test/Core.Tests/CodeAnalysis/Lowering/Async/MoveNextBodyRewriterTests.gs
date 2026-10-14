// <copyright file="MoveNextBodyRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading.Tasks
import Xunit

/// Unit tests for (cref:MoveNextBodyRewriter). These tests construct
/// bound trees via the async state-machine rewriter pipeline and verify the
/// structural shape of the produced MoveNext body.
open class MoveNextBodyRewriterTests {
    @Fact
    func Build_ZeroAwaits_ProducesDispatchSkeleton() {
        // Arrange: async body with no awaits
        let function = FunctionSymbol(
            "noAwait",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundExpressionStatement(nil, BoundLiteralExpression(nil, 42)))
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: body has try/catch structure + return
        Assert.NotNull(result)
        Assert.NotNull(result.Body)
        Assert.NotNull(result.ThisParameter)
        // Should contain: cachedState decl, try/catch, return
        let stmts = result.Body.Statements
        Assert.True(stmts.Length >= 3)
        // First: int cachedState = this.<>1__state
        let cachedDecl = Assert.IsType[BoundVariableDeclaration](stmts[0])
        Assert.Equal("<>cachedState", cachedDecl.Variable.Name)
        // Try statement wraps the body
        let tryStmt = Assert.IsType[BoundTryStatement](stmts[^2])
        Assert.Single(tryStmt.CatchClauses)
        // Last: return
        Assert.IsType[BoundReturnStatement](stmts[^1])
        // Inside try: dispatch label, user body, exprReturnLabel, state=-2, SetResult, exitLabel
        let tryStmts = GetTryBodyStatements(tryStmt)
        Assert.True(tryStmts.Length >= 4)
        // Dispatch label first
        let dispatchLabel = Assert.IsType[BoundLabelStatement](tryStmts[0])
        Assert.Equal(plan.MoveNextPlan.DispatchLabel.Name, dispatchLabel.Label.Name)
        // ExpressionReturnLabel should appear somewhere in the try body
        let hasExprReturn = tryStmts.Any(
            (s BoundStatement) -> s is BoundLabelStatement ls &&
                ls
                .Label
                .Name == plan
                .MoveNextPlan
                .ExpressionReturnLabel
                .Name
        )
        Assert.True(hasExprReturn, "ExpressionReturnLabel should be present in try body.")
        // ExitLabel should appear at the end of try body
        let lastTryStmt = tryStmts[^1]
        let exitLabel = Assert.IsType[BoundLabelStatement](lastTryStmt)
        Assert.Equal(plan.MoveNextPlan.ExitLabel.Name, exitLabel.Label.Name)
    }

    @Fact
    func Build_SingleAwait_ProducesPerAwaitSequence() {
        // Arrange: async body with one await
        let awaitExpr = MakeTaskAwait()
        let function = FunctionSymbol(
            "oneAwait",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundExpressionStatement(nil, awaitExpr))
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: verify per-await sequence landmarks
        let tryStmt = FindTryStatement(result.Body)
        let tryStmts = GetTryBodyStatements(tryStmt)
        let allStmts = FlattenStatements(tryStmts)
        // Should contain AwaitYieldPoint and AwaitResumePoint markers
        let yieldPoints = allStmts
            .OfType[BoundAwaitSequencePoint]()
            .Where((sp BoundAwaitSequencePoint) -> sp.Kind == BoundNodeKind.AwaitYieldPoint)
            .ToList()
        let resumePoints = allStmts
            .OfType[BoundAwaitSequencePoint]()
            .Where((sp BoundAwaitSequencePoint) -> sp.Kind == BoundNodeKind.AwaitResumePoint)
            .ToList()
        Assert.Single(yieldPoints)
        Assert.Single(resumePoints)
        Assert.Equal(0, yieldPoints[0].State)
        Assert.Equal(0, resumePoints[0].State)
        // Should contain state write (this.<>1__state = 0)
        let stateWrites = FindFieldAssignments(tryStmts, plan.FieldMap.StateField)
        Assert.True(
            stateWrites.Any((w BoundFieldAssignmentExpression) -> IsLiteralValue(w, 0)),
            "State should be set to 0 during suspension."
        )
        // Should have a goto exitLabel (suspension return path)
        let gotos = allStmts.OfType[BoundGotoStatement]().ToList()
        Assert.True(
            gotos.Any((g BoundGotoStatement) -> g.Label.Name == plan.MoveNextPlan.ExitLabel.Name),
            "Suspension path should goto exitLabel."
        )
        // Should have a resume label
        let resumeLabels = allStmts
            .OfType[BoundLabelStatement]()
            .Where((ls BoundLabelStatement) -> ls.Label.Name.Contains("await_resume_"))
            .ToList()
        Assert.True(resumeLabels.Count >= 1, "Should have at least one resume label.")
        // AwaitOnCompleted marker present
        let awaitOnCompleted = FindExpressions[BoundStateMachineAwaitOnCompleted](tryStmts)
        Assert.Single(awaitOnCompleted)
    }

    @Fact
    func Build_TwoAwaits_UseDistinctStates() {
        // Arrange: two awaits get states 0 and 1
        let await1 = MakeTaskAwait()
        let await2 = MakeTaskAwait()
        let function = FunctionSymbol(
            "twoAwaits",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundExpressionStatement(nil, await1), BoundExpressionStatement(nil, await2))
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: two AwaitYieldPoint markers with distinct states
        let tryStmt = FindTryStatement(result.Body)
        let allStmts = FlattenStatements(GetTryBodyStatements(tryStmt))
        let yieldPoints = allStmts
            .OfType[BoundAwaitSequencePoint]()
            .Where((sp BoundAwaitSequencePoint) -> sp.Kind == BoundNodeKind.AwaitYieldPoint)
            .ToList()
        Assert.Equal(2, yieldPoints.Count)
        Assert.Equal(0, yieldPoints[0].State)
        Assert.Equal(1, yieldPoints[1].State)
        // State dispatch should have two conditional gotos (at top level)
        let conditionalGotos = GetTryBodyStatements(tryStmt).OfType[BoundConditionalGotoStatement]().ToList()
        Assert.Equal(2, conditionalGotos.Count)
    }

    @Fact
    func Build_AwaitAsInitializer_StoresResultIntoHoistedField() {
        // Arrange: x := await Task.FromResult(1)
        let awaitExpr = MakeTaskIntAwait()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let function = FunctionSymbol(
            "initAwait",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundVariableDeclaration(nil, x, awaitExpr))
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: the hoisted local 'x' should be stored via field write
        let tryStmt = FindTryStatement(result.Body)
        let fieldAssigns = FindAllFieldAssignments(GetTryBodyStatements(tryStmt))
        // There should be at least one field assignment for the result (GetResult stored into hoisted field)
        // The variable 'x' is hoisted so its write goes through a BoundFieldAssignmentExpression
        Assert.True(fieldAssigns.Count > 0, "Hoisted local should be written through field assignment.")
    }

    @Fact
    func Build_AwaitInAssignment_RoutesRhsThroughPerAwaitSequence() {
        // Arrange: x = await Task.FromResult(1)
        let awaitExpr = MakeTaskIntAwait()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let function = FunctionSymbol(
            "assignAwait",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block(
            BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 0)),
            BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, awaitExpr))
        )
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: per-await sequence present
        let tryStmt = FindTryStatement(result.Body)
        let allStmts = FlattenStatements(GetTryBodyStatements(tryStmt))
        let yieldPoints = allStmts
            .OfType[BoundAwaitSequencePoint]()
            .Where((sp BoundAwaitSequencePoint) -> sp.Kind == BoundNodeKind.AwaitYieldPoint)
            .ToList()
        Assert.Single(yieldPoints)
    }

    @Fact
    func Build_AwaitYieldAndResumePointMarkers_HaveMatchingStates() {
        // Arrange: body with single await — both markers must share state number
        let awaitExpr = MakeTaskAwait()
        let function = FunctionSymbol(
            "markers",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundExpressionStatement(nil, awaitExpr))
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert
        let tryStmt = FindTryStatement(result.Body)
        let allStmts = FlattenStatements(GetTryBodyStatements(tryStmt))
        let seqPoints = allStmts.OfType[BoundAwaitSequencePoint]().ToList()
        Assert.Equal(2, seqPoints.Count)
        let yieldPoint = seqPoints.First((sp BoundAwaitSequencePoint) -> sp.Kind == BoundNodeKind.AwaitYieldPoint)
        let resumePoint = seqPoints.First((sp BoundAwaitSequencePoint) -> sp.Kind == BoundNodeKind.AwaitResumePoint)
        Assert.Equal(yieldPoint.State, resumePoint.State)
    }

    @Fact
    func Build_ReturnInAsyncBody_LowersToGotoExprReturnLabel() {
        // Arrange: async function returning int with explicit return
        let function = FunctionSymbol(
            "retVal",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Int32,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundReturnStatement(nil, BoundLiteralExpression(nil, 99)))
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: no BoundReturnStatement inside try body (funneled to goto)
        let tryStmt = FindTryStatement(result.Body)
        let innerReturns = GetTryBodyStatements(tryStmt).OfType[BoundReturnStatement]().ToList()
        Assert.Empty(innerReturns)
        // Should contain a goto to ExpressionReturnLabel
        let allGotos = FlattenGotos(GetTryBodyStatements(tryStmt))
        Assert.True(
            allGotos.Any((g BoundGotoStatement) -> g.Label.Name == plan.MoveNextPlan.ExpressionReturnLabel.Name),
            "Return should be funneled to ExpressionReturnLabel via goto."
        )
    }

    @Fact
    func Build_HoistedLocalReadWrite_RoutedThroughFieldAccess() {
        // Arrange: local that is live across await → should be hoisted
        let awaitExpr = MakeTaskAwait()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let function = FunctionSymbol(
            "hoisted",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        // x := 5; await ...; use x
        let body = Block(
            BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 5)),
            BoundExpressionStatement(nil, awaitExpr),
            BoundExpressionStatement(nil, BoundVariableExpression(nil, x))
        )
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: reads/writes of 'x' go through field accesses on the SM
        let tryStmt = FindTryStatement(result.Body)
        let fieldAccesses = FindExpressions[BoundFieldAccessExpression](GetTryBodyStatements(tryStmt))
        // Should have field reads for 'x' (via BoundFieldAccessExpression)
        // The exact count depends on implementation, but there must be some
        Assert.True(fieldAccesses.Count > 0, "Hoisted local reads should produce BoundFieldAccessExpression nodes.")
    }

    @Fact
    func Build_CatchBody_SetsFinishedStateAndCallsSetException() {
        // Arrange: any async body
        let function = FunctionSymbol(
            "catchCheck",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block()
        let plan = BuildPlan(function, body)
        // Act
        let result = MoveNextBodyRewriter.Build(plan)
        // Assert: catch clause sets state to -2 and calls SetException
        let tryStmt = FindTryStatement(result.Body)
        let catchClause = Assert.Single(tryStmt.CatchClauses)
        Assert.Contains("<>ex", catchClause.Variable!!.Name)
        let catchBody BoundBlockStatement? = catchClause.Body as BoundBlockStatement
        Assert.NotNull(catchBody)
        // Should have field write for state = -2
        let stateWrites = FindFieldAssignments(catchBody!!.Statements, plan.FieldMap.StateField)
        Assert.Contains(
            stateWrites,
            (w BoundFieldAssignmentExpression) -> IsLiteralValue(w, StateMachineStates.FinishedState)
        )
    }

    shared {
        private let Package PackageSymbol = PackageSymbol("main", declaration: nil)
        private let Resolver ReferenceResolver = ReferenceResolver.Default()

        private func Block(statements ...BoundStatement) BoundBlockStatement {
            return BoundBlockStatement(nil, statements.ToImmutableArray())
        }

        private func MakeTaskAwait() BoundAwaitExpression {
            // Await on a Task (void result) — use Task type so AwaitableShape resolves
            return BoundAwaitExpression(
                nil,
                BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task))),
                TypeSymbol.Void
            )
        }

        private func MakeTaskIntAwait() BoundAwaitExpression {
            // Await on a Task<int> — result type is int
            return BoundAwaitExpression(
                nil,
                BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task[int32]))),
                TypeSymbol.Int32
            )
        }

        private func BuildPlan(function FunctionSymbol, body BoundBlockStatement) AsyncStateMachinePlan {
            let program = BoundProgram(
                Package,
                ImmutableArray.Create(Package),
                ImmutableArray[Diagnostic].Empty,
                ImmutableDictionary
                    .CreateBuilder[FunctionSymbol, BoundBlockStatement]()
                    .ToImmutable()
                    .Add(function, body),
                entryPoint: nil,
                statement: Block(),
                structs: ImmutableArray[StructSymbol].Empty,
                interfaces: ImmutableArray[InterfaceSymbol].Empty
            )
            let result = AsyncStateMachineRewriter.Rewrite(program, Resolver)
            return result.StateMachines.Single()
        }

        private func FindTryStatement(body BoundBlockStatement) BoundTryStatement {
            return body.Statements.OfType[BoundTryStatement]().Single()
        }

        private func GetTryBodyStatements(tryStmt BoundTryStatement) ImmutableArray[BoundStatement] {
            let tryBlock BoundBlockStatement? = tryStmt.TryBlock as BoundBlockStatement
            Assert.NotNull(tryBlock)
            return tryBlock!!.Statements
        }

        private func FlattenStatements(stmts ImmutableArray[BoundStatement]) List[BoundStatement] {
            let result = List[BoundStatement]()
            for stmt in stmts {
                FlattenRecursive(stmt, result)
            }
            return result
        }

        private func FlattenRecursive(stmt BoundStatement, results List[BoundStatement]) {
            results.Add(stmt)
            if stmt is BoundBlockStatement block {
                for inner in block.Statements {
                    FlattenRecursive(inner, results)
                }
            }
        }

        private func FindFieldAssignments(stmts ImmutableArray[BoundStatement], targetField FieldSymbol) List[
            BoundFieldAssignmentExpression
        ] {
            let results = List[BoundFieldAssignmentExpression]()
            for stmt in stmts {
                CollectFieldAssignmentsRecursive(stmt, targetField, results)
            }
            return results
        }

        private func CollectFieldAssignmentsRecursive(
            stmt BoundStatement,
            targetField FieldSymbol,
            results List[BoundFieldAssignmentExpression]
        ) {
            if stmt is BoundExpressionStatement es &&
                es.Expression is BoundFieldAssignmentExpression fa &&
                fa
                .Field
                .Name == targetField.Name {
                results.Add(fa)
            } else if stmt is BoundBlockStatement block {
                for inner in block.Statements {
                    CollectFieldAssignmentsRecursive(inner, targetField, results)
                }
            }
        }

        private func FindAllFieldAssignments(stmts ImmutableArray[BoundStatement]) List[
            BoundFieldAssignmentExpression
        ] {
            let results = List[BoundFieldAssignmentExpression]()
            for stmt in stmts {
                CollectAllFieldAssignmentsRecursive(stmt, results)
            }
            return results
        }

        private func CollectAllFieldAssignmentsRecursive(
            stmt BoundStatement,
            results List[BoundFieldAssignmentExpression]
        ) {
            if stmt is BoundExpressionStatement es && es.Expression is BoundFieldAssignmentExpression fa {
                results.Add(fa)
            } else if stmt is BoundBlockStatement block {
                for inner in block.Statements {
                    CollectAllFieldAssignmentsRecursive(inner, results)
                }
            }
        }

        private func FindExpressions[T BoundExpression](stmts ImmutableArray[BoundStatement]) List[T] {
            let results = List[T]()
            for stmt in stmts {
                CollectExpressionsRecursive[T](stmt, results)
            }
            return results
        }

        private func CollectExpressionsRecursive[T BoundExpression](stmt BoundStatement, results List[T]) {
            if stmt is BoundExpressionStatement es {
                if es.Expression is T target {
                    results.Add(target)
                }
            } else if stmt is BoundBlockStatement block {
                for inner in block.Statements {
                    CollectExpressionsRecursive(inner, results)
                }
            } else if stmt is BoundVariableDeclaration vd {
                if vd.Initializer is T initTarget {
                    results.Add(initTarget)
                }
            }
        }

        private func FlattenGotos(stmts ImmutableArray[BoundStatement]) List[BoundGotoStatement] {
            let results = List[BoundGotoStatement]()
            for stmt in stmts {
                FlattenGotosRecursive(stmt, results)
            }
            return results
        }

        private func FlattenGotosRecursive(stmt BoundStatement, results List[BoundGotoStatement]) {
            if stmt is BoundGotoStatement g {
                results.Add(g)
            } else if stmt is BoundBlockStatement block {
                for inner in block.Statements {
                    FlattenGotosRecursive(inner, results)
                }
            }
        }

        private func IsLiteralValue(assign BoundFieldAssignmentExpression, expected int32) bool {
            return assign.Value is BoundLiteralExpression lit && lit.Value is int32 i && i == expected
        }
    }
}
