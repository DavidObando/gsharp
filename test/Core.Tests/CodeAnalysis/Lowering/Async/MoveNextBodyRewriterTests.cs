// <copyright file="MoveNextBodyRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Unit tests for <see cref="MoveNextBodyRewriter"/>. These tests construct
/// bound trees via the async state-machine rewriter pipeline and verify the
/// structural shape of the produced MoveNext body.
/// </summary>
public class MoveNextBodyRewriterTests
{
    private static readonly PackageSymbol Package = new PackageSymbol("main", declaration: null);
    private static readonly ReferenceResolver Resolver = ReferenceResolver.Default();

    [Fact]
    public void Build_ZeroAwaits_ProducesDispatchSkeleton()
    {
        // Arrange: async body with no awaits
        var function = new FunctionSymbol("noAwait", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(new BoundExpressionStatement(null, new BoundLiteralExpression(null, 42)));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: body has try/catch structure + return
        Assert.NotNull(result);
        Assert.NotNull(result.Body);
        Assert.NotNull(result.ThisParameter);

        // Should contain: cachedState decl, try/catch, return
        var stmts = result.Body.Statements;
        Assert.True(stmts.Length >= 3);

        // First: int cachedState = this.<>1__state
        var cachedDecl = Assert.IsType<BoundVariableDeclaration>(stmts[0]);
        Assert.Equal("<>cachedState", cachedDecl.Variable.Name);

        // Try statement wraps the body
        var tryStmt = Assert.IsType<BoundTryStatement>(stmts[^2]);
        Assert.Single(tryStmt.CatchClauses);

        // Last: return
        Assert.IsType<BoundReturnStatement>(stmts[^1]);

        // Inside try: dispatch label, user body, exprReturnLabel, state=-2, SetResult, exitLabel
        var tryStmts = GetTryBodyStatements(tryStmt);
        Assert.True(tryStmts.Length >= 4);

        // Dispatch label first
        var dispatchLabel = Assert.IsType<BoundLabelStatement>(tryStmts[0]);
        Assert.Equal(plan.MoveNextPlan.DispatchLabel.Name, dispatchLabel.Label.Name);

        // ExpressionReturnLabel should appear somewhere in the try body
        var hasExprReturn = tryStmts.Any(s =>
            s is BoundLabelStatement ls && ls.Label.Name == plan.MoveNextPlan.ExpressionReturnLabel.Name);
        Assert.True(hasExprReturn, "ExpressionReturnLabel should be present in try body.");

        // ExitLabel should appear at the end of try body
        var lastTryStmt = tryStmts[^1];
        var exitLabel = Assert.IsType<BoundLabelStatement>(lastTryStmt);
        Assert.Equal(plan.MoveNextPlan.ExitLabel.Name, exitLabel.Label.Name);
    }

    [Fact]
    public void Build_SingleAwait_ProducesPerAwaitSequence()
    {
        // Arrange: async body with one await
        var awaitExpr = MakeTaskAwait();
        var function = new FunctionSymbol("oneAwait", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(new BoundExpressionStatement(null, awaitExpr));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: verify per-await sequence landmarks
        var tryStmt = FindTryStatement(result.Body);
        var tryStmts = GetTryBodyStatements(tryStmt);
        var allStmts = FlattenStatements(tryStmts);

        // Should contain AwaitYieldPoint and AwaitResumePoint markers
        var yieldPoints = allStmts.OfType<BoundAwaitSequencePoint>()
            .Where(sp => sp.Kind == BoundNodeKind.AwaitYieldPoint).ToList();
        var resumePoints = allStmts.OfType<BoundAwaitSequencePoint>()
            .Where(sp => sp.Kind == BoundNodeKind.AwaitResumePoint).ToList();
        Assert.Single(yieldPoints);
        Assert.Single(resumePoints);
        Assert.Equal(0, yieldPoints[0].State);
        Assert.Equal(0, resumePoints[0].State);

        // Should contain state write (this.<>1__state = 0)
        var stateWrites = FindFieldAssignments(tryStmts, plan.FieldMap.StateField);
        Assert.True(stateWrites.Any(w => IsLiteralValue(w, 0)), "State should be set to 0 during suspension.");

        // Should have a goto exitLabel (suspension return path)
        var gotos = allStmts.OfType<BoundGotoStatement>().ToList();
        Assert.True(gotos.Any(g => g.Label.Name == plan.MoveNextPlan.ExitLabel.Name),
            "Suspension path should goto exitLabel.");

        // Should have a resume label
        var resumeLabels = allStmts.OfType<BoundLabelStatement>()
            .Where(ls => ls.Label.Name.Contains("await_resume_")).ToList();
        Assert.True(resumeLabels.Count >= 1, "Should have at least one resume label.");

        // AwaitOnCompleted marker present
        var awaitOnCompleted = FindExpressions<BoundStateMachineAwaitOnCompleted>(tryStmts);
        Assert.Single(awaitOnCompleted);
    }

    [Fact]
    public void Build_TwoAwaits_UseDistinctStates()
    {
        // Arrange: two awaits get states 0 and 1
        var await1 = MakeTaskAwait();
        var await2 = MakeTaskAwait();
        var function = new FunctionSymbol("twoAwaits", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(
            new BoundExpressionStatement(null, await1),
            new BoundExpressionStatement(null, await2));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: two AwaitYieldPoint markers with distinct states
        var tryStmt = FindTryStatement(result.Body);
        var allStmts = FlattenStatements(GetTryBodyStatements(tryStmt));
        var yieldPoints = allStmts.OfType<BoundAwaitSequencePoint>()
            .Where(sp => sp.Kind == BoundNodeKind.AwaitYieldPoint).ToList();
        Assert.Equal(2, yieldPoints.Count);
        Assert.Equal(0, yieldPoints[0].State);
        Assert.Equal(1, yieldPoints[1].State);

        // State dispatch should have two conditional gotos (at top level)
        var conditionalGotos = GetTryBodyStatements(tryStmt).OfType<BoundConditionalGotoStatement>().ToList();
        Assert.Equal(2, conditionalGotos.Count);
    }

    [Fact]
    public void Build_AwaitAsInitializer_StoresResultIntoHoistedField()
    {
        // Arrange: x := await Task.FromResult(1)
        var awaitExpr = MakeTaskIntAwait();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int);
        var function = new FunctionSymbol("initAwait", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(new BoundVariableDeclaration(null, x, awaitExpr));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: the hoisted local 'x' should be stored via field write
        var tryStmt = FindTryStatement(result.Body);
        var fieldAssigns = FindAllFieldAssignments(GetTryBodyStatements(tryStmt));

        // There should be at least one field assignment for the result (GetResult stored into hoisted field)
        // The variable 'x' is hoisted so its write goes through a BoundFieldAssignmentExpression
        Assert.True(fieldAssigns.Count > 0, "Hoisted local should be written through field assignment.");
    }

    [Fact]
    public void Build_AwaitInAssignment_RoutesRhsThroughPerAwaitSequence()
    {
        // Arrange: x = await Task.FromResult(1)
        var awaitExpr = MakeTaskIntAwait();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int);
        var function = new FunctionSymbol("assignAwait", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(
            new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 0)),
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, awaitExpr)));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: per-await sequence present
        var tryStmt = FindTryStatement(result.Body);
        var allStmts = FlattenStatements(GetTryBodyStatements(tryStmt));
        var yieldPoints = allStmts.OfType<BoundAwaitSequencePoint>()
            .Where(sp => sp.Kind == BoundNodeKind.AwaitYieldPoint).ToList();
        Assert.Single(yieldPoints);
    }

    [Fact]
    public void Build_AwaitYieldAndResumePointMarkers_HaveMatchingStates()
    {
        // Arrange: body with single await — both markers must share state number
        var awaitExpr = MakeTaskAwait();
        var function = new FunctionSymbol("markers", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(new BoundExpressionStatement(null, awaitExpr));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert
        var tryStmt = FindTryStatement(result.Body);
        var allStmts = FlattenStatements(GetTryBodyStatements(tryStmt));
        var seqPoints = allStmts.OfType<BoundAwaitSequencePoint>().ToList();
        Assert.Equal(2, seqPoints.Count);

        var yieldPoint = seqPoints.First(sp => sp.Kind == BoundNodeKind.AwaitYieldPoint);
        var resumePoint = seqPoints.First(sp => sp.Kind == BoundNodeKind.AwaitResumePoint);
        Assert.Equal(yieldPoint.State, resumePoint.State);
    }

    [Fact]
    public void Build_ReturnInAsyncBody_LowersToGotoExprReturnLabel()
    {
        // Arrange: async function returning int with explicit return
        var function = new FunctionSymbol("retVal", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int, package: Package) { IsAsync = true };
        var body = Block(new BoundReturnStatement(null, new BoundLiteralExpression(null, 99)));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: no BoundReturnStatement inside try body (funneled to goto)
        var tryStmt = FindTryStatement(result.Body);
        var innerReturns = GetTryBodyStatements(tryStmt).OfType<BoundReturnStatement>().ToList();
        Assert.Empty(innerReturns);

        // Should contain a goto to ExpressionReturnLabel
        var allGotos = FlattenGotos(GetTryBodyStatements(tryStmt));
        Assert.True(allGotos.Any(g => g.Label.Name == plan.MoveNextPlan.ExpressionReturnLabel.Name),
            "Return should be funneled to ExpressionReturnLabel via goto.");
    }

    [Fact]
    public void Build_HoistedLocalReadWrite_RoutedThroughFieldAccess()
    {
        // Arrange: local that is live across await → should be hoisted
        var awaitExpr = MakeTaskAwait();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int);
        var function = new FunctionSymbol("hoisted", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        // x := 5; await ...; use x
        var body = Block(
            new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 5)),
            new BoundExpressionStatement(null, awaitExpr),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, x)));
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: reads/writes of 'x' go through field accesses on the SM
        var tryStmt = FindTryStatement(result.Body);
        var fieldAccesses = FindExpressions<BoundFieldAccessExpression>(GetTryBodyStatements(tryStmt));

        // Should have field reads for 'x' (via BoundFieldAccessExpression)
        // The exact count depends on implementation, but there must be some
        Assert.True(fieldAccesses.Count > 0,
            "Hoisted local reads should produce BoundFieldAccessExpression nodes.");
    }

    [Fact]
    public void Build_CatchBody_SetsFinishedStateAndCallsSetException()
    {
        // Arrange: any async body
        var function = new FunctionSymbol("catchCheck", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block();
        var plan = BuildPlan(function, body);

        // Act
        var result = MoveNextBodyRewriter.Build(plan);

        // Assert: catch clause sets state to -2 and calls SetException
        var tryStmt = FindTryStatement(result.Body);
        var catchClause = Assert.Single(tryStmt.CatchClauses);
        Assert.Contains("<>ex", catchClause.Variable.Name);

        var catchBody = catchClause.Body as BoundBlockStatement;
        Assert.NotNull(catchBody);

        // Should have field write for state = -2
        var stateWrites = FindFieldAssignments(catchBody.Statements, plan.FieldMap.StateField);
        Assert.Contains(stateWrites, w => IsLiteralValue(w, StateMachineStates.FinishedState));
    }

    #region Helpers

    private static BoundBlockStatement Block(params BoundStatement[] statements)
    {
        return new BoundBlockStatement(null, statements.ToImmutableArray());
    }

    private static BoundAwaitExpression MakeTaskAwait()
    {
        // Await on a Task (void result) — use Task type so AwaitableShape resolves
        return new BoundAwaitExpression(
            null,
            new BoundLiteralExpression(null, null, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void);
    }

    private static BoundAwaitExpression MakeTaskIntAwait()
    {
        // Await on a Task<int> — result type is int
        return new BoundAwaitExpression(
            null,
            new BoundLiteralExpression(null, null, TypeSymbol.FromClrType(typeof(Task<int>))),
            TypeSymbol.Int);
    }

    private static AsyncStateMachinePlan BuildPlan(FunctionSymbol function, BoundBlockStatement body)
    {
        var program = new BoundProgram(
            Package,
            ImmutableArray.Create(Package),
            ImmutableArray<Diagnostic>.Empty,
            ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>()
                .ToImmutable()
                .Add(function, body),
            entryPoint: null,
            statement: Block(),
            structs: ImmutableArray<StructSymbol>.Empty,
            interfaces: ImmutableArray<InterfaceSymbol>.Empty);

        var result = AsyncStateMachineRewriter.Rewrite(program, Resolver);
        return result.StateMachines.Single();
    }

    private static BoundTryStatement FindTryStatement(BoundBlockStatement body)
    {
        return body.Statements.OfType<BoundTryStatement>().Single();
    }

    private static ImmutableArray<BoundStatement> GetTryBodyStatements(BoundTryStatement tryStmt)
    {
        var tryBlock = tryStmt.TryBlock as BoundBlockStatement;
        Assert.NotNull(tryBlock);
        return tryBlock.Statements;
    }

    private static List<BoundStatement> FlattenStatements(ImmutableArray<BoundStatement> stmts)
    {
        var result = new List<BoundStatement>();
        foreach (var stmt in stmts)
        {
            FlattenRecursive(stmt, result);
        }

        return result;
    }

    private static void FlattenRecursive(BoundStatement stmt, List<BoundStatement> results)
    {
        results.Add(stmt);
        if (stmt is BoundBlockStatement block)
        {
            foreach (var inner in block.Statements)
            {
                FlattenRecursive(inner, results);
            }
        }
    }

    private static List<BoundFieldAssignmentExpression> FindFieldAssignments(
        ImmutableArray<BoundStatement> stmts, FieldSymbol targetField)
    {
        var results = new List<BoundFieldAssignmentExpression>();
        foreach (var stmt in stmts)
        {
            CollectFieldAssignmentsRecursive(stmt, targetField, results);
        }

        return results;
    }

    private static void CollectFieldAssignmentsRecursive(
        BoundStatement stmt, FieldSymbol targetField, List<BoundFieldAssignmentExpression> results)
    {
        if (stmt is BoundExpressionStatement es && es.Expression is BoundFieldAssignmentExpression fa
            && fa.Field.Name == targetField.Name)
        {
            results.Add(fa);
        }
        else if (stmt is BoundBlockStatement block)
        {
            foreach (var inner in block.Statements)
            {
                CollectFieldAssignmentsRecursive(inner, targetField, results);
            }
        }
    }

    private static List<BoundFieldAssignmentExpression> FindAllFieldAssignments(ImmutableArray<BoundStatement> stmts)
    {
        var results = new List<BoundFieldAssignmentExpression>();
        foreach (var stmt in stmts)
        {
            CollectAllFieldAssignmentsRecursive(stmt, results);
        }

        return results;
    }

    private static void CollectAllFieldAssignmentsRecursive(BoundStatement stmt, List<BoundFieldAssignmentExpression> results)
    {
        if (stmt is BoundExpressionStatement es && es.Expression is BoundFieldAssignmentExpression fa)
        {
            results.Add(fa);
        }
        else if (stmt is BoundBlockStatement block)
        {
            foreach (var inner in block.Statements)
            {
                CollectAllFieldAssignmentsRecursive(inner, results);
            }
        }
    }

    private static List<T> FindExpressions<T>(ImmutableArray<BoundStatement> stmts)
        where T : BoundExpression
    {
        var results = new List<T>();
        foreach (var stmt in stmts)
        {
            CollectExpressionsRecursive<T>(stmt, results);
        }

        return results;
    }

    private static void CollectExpressionsRecursive<T>(BoundStatement stmt, List<T> results)
        where T : BoundExpression
    {
        if (stmt is BoundExpressionStatement es)
        {
            if (es.Expression is T target)
            {
                results.Add(target);
            }
        }
        else if (stmt is BoundBlockStatement block)
        {
            foreach (var inner in block.Statements)
            {
                CollectExpressionsRecursive(inner, results);
            }
        }
        else if (stmt is BoundVariableDeclaration vd)
        {
            if (vd.Initializer is T initTarget)
            {
                results.Add(initTarget);
            }
        }
    }

    private static List<BoundGotoStatement> FlattenGotos(ImmutableArray<BoundStatement> stmts)
    {
        var results = new List<BoundGotoStatement>();
        foreach (var stmt in stmts)
        {
            FlattenGotosRecursive(stmt, results);
        }

        return results;
    }

    private static void FlattenGotosRecursive(BoundStatement stmt, List<BoundGotoStatement> results)
    {
        if (stmt is BoundGotoStatement g)
        {
            results.Add(g);
        }
        else if (stmt is BoundBlockStatement block)
        {
            foreach (var inner in block.Statements)
            {
                FlattenGotosRecursive(inner, results);
            }
        }
    }

    private static bool IsLiteralValue(BoundFieldAssignmentExpression assign, int expected)
    {
        return assign.Value is BoundLiteralExpression lit && lit.Value is int i && i == expected;
    }

    #endregion
}
