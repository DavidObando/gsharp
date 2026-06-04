// <copyright file="RefInitializationHoisterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class RefInitializationHoisterTests
{
    [Fact]
    public void RefLocal_NotCrossingAwait_LeftAlone()
    {
        // A body with no await: the hoister still eliminates ref locals
        // (conservative V1 approach for async bodies), but let's verify that
        // the non-ref parts are untouched.
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var y = new LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.Int32);

        // var x = 42
        // var y = x + 1
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 42)),
            new BoundVariableDeclaration(null,
y, new BoundBinaryExpression(
                null,
                new BoundVariableExpression(null, x),
                BoundBinaryOperator.Bind(Core.CodeAnalysis.Syntax.SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                new BoundLiteralExpression(null, 1)))));

        var result = RefInitializationHoister.Rewrite(body);

        // No ref locals → body unchanged (same reference).
        Assert.Same(body, result);
    }

    [Fact]
    public void RefLocal_To_Local_CrossingAwait_RewritesUseToAddressOfHoistedLocal()
    {
        // var x = 10
        // var slot = &x   (ref local: type *int, initializer is BoundAddressOfExpression)
        // ... (imagine await here) ...
        // *slot            (dereference → should become just `x`)
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var declX = new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 10));
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, new BoundVariableExpression(null, x)));

        // Use: *slot (dereference)
        var deref = new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot));
        var useStmt = new BoundExpressionStatement(null, deref);

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declX, declSlot, useStmt));

        var result = RefInitializationHoister.Rewrite(body);

        // The ref local declaration should be removed (replaced with empty block).
        Assert.NotSame(body, result);
        var stmts = result.Statements;

        // Statement 0: var x = 10 (unchanged)
        Assert.IsType<BoundVariableDeclaration>(stmts[0]);
        var declXResult = (BoundVariableDeclaration)stmts[0];
        Assert.Equal("x", declXResult.Variable.Name);

        // Statement 1: empty block (ref local decl removed)
        Assert.IsType<BoundBlockStatement>(stmts[1]);
        Assert.Empty(((BoundBlockStatement)stmts[1]).Statements);

        // Statement 2: expression statement with the inlined operand (x, not *slot)
        Assert.IsType<BoundExpressionStatement>(stmts[2]);
        var expr = ((BoundExpressionStatement)stmts[2]).Expression;
        Assert.IsType<BoundVariableExpression>(expr);
        Assert.Equal("x", ((BoundVariableExpression)expr).Variable.Name);
    }

    [Fact]
    public void RefLocal_To_ArrayElement_CrossingAwait_HoistsArrayAndIndex()
    {
        // var arr = [array]
        // var i = 2
        // var slot = &arr[i]  (ref local, initializer = BoundAddressOfExpression(BoundIndexExpression(arr, i)))
        // *slot               (should become arr[i])
        var arr = new LocalVariableSymbol("arr", isReadOnly: false, TypeSymbol.FromClrType(typeof(int[])));
        var i = new LocalVariableSymbol("i", isReadOnly: false, TypeSymbol.Int32);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var indexExpr = new BoundIndexExpression(
            null,
            new BoundVariableExpression(null, arr),
            new BoundVariableExpression(null, i),
            TypeSymbol.Int32);
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, indexExpr));

        var deref = new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot));
        var useStmt = new BoundExpressionStatement(null, deref);

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declSlot, useStmt));

        var result = RefInitializationHoister.Rewrite(body);
        var stmts = result.Statements;

        // Statement 0: empty block (ref local decl removed)
        Assert.IsType<BoundBlockStatement>(stmts[0]);

        // Statement 1: expression is arr[i] (BoundIndexExpression)
        Assert.IsType<BoundExpressionStatement>(stmts[1]);
        var expr = ((BoundExpressionStatement)stmts[1]).Expression;
        Assert.IsType<BoundIndexExpression>(expr);
        var idx = (BoundIndexExpression)expr;
        Assert.IsType<BoundVariableExpression>(idx.Target);
        Assert.Equal("arr", ((BoundVariableExpression)idx.Target).Variable.Name);
        Assert.IsType<BoundVariableExpression>(idx.Index);
        Assert.Equal("i", ((BoundVariableExpression)idx.Index).Variable.Name);
    }

    [Fact]
    public void RefLocal_To_FieldAccess_CrossingAwait_HoistsReceiver()
    {
        // var slot = &obj.field  (ref local)
        // *slot                  (should become obj.field)
        var field = new FieldSymbol("value", TypeSymbol.Int32, Accessibility.Public);
        var structType = new StructSymbol("MyStruct", ImmutableArray.Create(field), Accessibility.Public, null, "test");
        var obj = new LocalVariableSymbol("obj", isReadOnly: false, structType);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var fieldAccess = new BoundFieldAccessExpression(
            null,
            new BoundVariableExpression(null, obj), structType, field);
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, fieldAccess));

        var deref = new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot));
        var useStmt = new BoundExpressionStatement(null, deref);

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declSlot, useStmt));

        var result = RefInitializationHoister.Rewrite(body);
        var stmts = result.Statements;

        // Statement 1: expression is obj.field (BoundFieldAccessExpression)
        Assert.IsType<BoundExpressionStatement>(stmts[1]);
        var expr = ((BoundExpressionStatement)stmts[1]).Expression;
        Assert.IsType<BoundFieldAccessExpression>(expr);
        var fa = (BoundFieldAccessExpression)expr;
        Assert.Equal("value", fa.Field.Name);
    }

    [Fact]
    public void NonAsync_Function_NotProcessed()
    {
        // When body is null, Rewrite returns null.
        var result = RefInitializationHoister.Rewrite(null);
        Assert.Null(result);
    }

    [Fact]
    public void RefLocal_To_ArrayElement_WithSideEffectingTarget_HoistsTargetOnce()
    {
        // Issue #418 / P1-12: `ref int x = ref Arr()[Idx()]; *x = 1; *x = 2;`
        // The old hoister inlined the operand at every use, evaluating Arr()
        // and Idx() once per use. The fix hoists each side-effecting subpart
        // into a single temp local at the ref-init site so every use re-derives
        // the lvalue from the same evaluated state.
        var idxMethod = typeof(System.Array).GetMethod("GetLength")!; // any MethodInfo will do — we just need something non-trivial as `target`/`index`.
        var arrType = TypeSymbol.FromClrType(typeof(int[]));

        // Use BoundClrStaticCall to fabricate Arr() and Idx().
        var arrCallType = arrType;
        var idxCallType = TypeSymbol.Int32;

        // Reuse a real static method whose signature happens to match: we only
        // care about reference equality through the rewriter; runtime semantics
        // aren't exercised by the unit test. System.Array.Empty<int>() returns int[].
        var arrFactoryMethod = typeof(System.Array).GetMethod(nameof(System.Array.Empty))!.MakeGenericMethod(typeof(int));

        // System.Environment.TickCount is an int property — too awkward. Use Math.Abs(int) as Idx().
        var idxFactoryMethod = typeof(System.Math).GetMethod(nameof(System.Math.Abs), new[] { typeof(int) })!;

        var arrCall = new BoundClrStaticCallExpression(
            null,
            arrFactoryMethod,
            arrCallType,
            ImmutableArray<BoundExpression>.Empty);

        var idxCall = new BoundClrStaticCallExpression(
            null,
            idxFactoryMethod,
            idxCallType,
            ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(null, 3)));

        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));
        var indexExpr = new BoundIndexExpression(null, arrCall, idxCall, TypeSymbol.Int32);
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, indexExpr));

        // Two uses of *slot — the original bug would have evaluated arrCall and
        // idxCall twice.
        var use1 = new BoundExpressionStatement(null, new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot)));
        var use2 = new BoundExpressionStatement(null, new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot)));

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declSlot, use1, use2));

        var result = RefInitializationHoister.Rewrite(body);
        var stmts = result.Statements;

        // Statement 0: prelude block declaring two temps (one for arrCall, one for idxCall).
        var prelude = Assert.IsType<BoundBlockStatement>(stmts[0]);
        Assert.Equal(2, prelude.Statements.Length);

        var t0Decl = Assert.IsType<BoundVariableDeclaration>(prelude.Statements[0]);
        var t1Decl = Assert.IsType<BoundVariableDeclaration>(prelude.Statements[1]);
        Assert.Same(arrCall, t0Decl.Initializer);
        Assert.Same(idxCall, t1Decl.Initializer);

        // Statements 1 and 2: each use is `temp0[temp1]` — same temp symbols, not the original calls.
        BoundIndexExpression ReadUse(BoundStatement s)
        {
            var es = Assert.IsType<BoundExpressionStatement>(s);
            return Assert.IsType<BoundIndexExpression>(es.Expression);
        }

        var idx1 = ReadUse(stmts[1]);
        var idx2 = ReadUse(stmts[2]);

        Assert.Same(t0Decl.Variable, ((BoundVariableExpression)idx1.Target).Variable);
        Assert.Same(t1Decl.Variable, ((BoundVariableExpression)idx1.Index).Variable);
        Assert.Same(t0Decl.Variable, ((BoundVariableExpression)idx2.Target).Variable);
        Assert.Same(t1Decl.Variable, ((BoundVariableExpression)idx2.Index).Variable);

        // Crucially: the call expressions appear EXACTLY ONCE across the whole
        // rewritten body — in the prelude. Repeated references would indicate
        // the side-effect-duplication bug.
        int CountSubtreeRefs(BoundExpression needle, BoundStatement haystack)
        {
            int count = 0;
            void Visit(object n)
            {
                if (n is null)
                {
                    return;
                }

                if (ReferenceEquals(n, needle))
                {
                    count++;
                    return;
                }

                switch (n)
                {
                    case BoundBlockStatement b:
                        foreach (var s in b.Statements) Visit(s);
                        break;
                    case BoundVariableDeclaration vd:
                        Visit(vd.Initializer);
                        break;
                    case BoundExpressionStatement es:
                        Visit(es.Expression);
                        break;
                    case BoundIndexExpression ix:
                        Visit(ix.Target);
                        Visit(ix.Index);
                        break;
                    case BoundAddressOfExpression ao:
                        Visit(ao.Operand);
                        break;
                    case BoundDereferenceExpression de:
                        Visit(de.Operand);
                        break;
                }
            }

            Visit(haystack);
            return count;
        }

        Assert.Equal(1, CountSubtreeRefs(arrCall, result));
        Assert.Equal(1, CountSubtreeRefs(idxCall, result));
    }

    [Fact]
    public void RefLocal_To_FieldAccess_WithSideEffectingReceiver_HoistsReceiverOnce()
    {
        // ref int x = ref GetObj().field; *x = 1; *x = 2;
        // The receiver call must be evaluated exactly once.
        var field = new FieldSymbol("value", TypeSymbol.Int32, Accessibility.Public);
        var structType = new StructSymbol("MyStruct", ImmutableArray.Create(field), Accessibility.Public, null, "test");

        // Synthesize a side-effecting "GetObj()" via a static CLR call. The runtime
        // type doesn't have to match — the rewriter is purely syntactic.
        var dummyMethod = typeof(System.Math).GetMethod(nameof(System.Math.Abs), new[] { typeof(int) })!;
        var receiverCall = new BoundClrStaticCallExpression(
            null,
            dummyMethod,
            structType,
            ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(null, 0)));

        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));
        var fa = new BoundFieldAccessExpression(null, receiverCall, structType, field);
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, fa));

        var use1 = new BoundExpressionStatement(null, new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot)));
        var use2 = new BoundExpressionStatement(null, new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot)));

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declSlot, use1, use2));

        var result = RefInitializationHoister.Rewrite(body);

        // Prelude: one temp local holding the receiver call result.
        var prelude = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        Assert.Single(prelude.Statements);
        var tempDecl = Assert.IsType<BoundVariableDeclaration>(prelude.Statements[0]);
        Assert.Same(receiverCall, tempDecl.Initializer);

        // Each use reads `temp.value` — same temp, never the original call.
        for (int i = 1; i <= 2; i++)
        {
            var es = Assert.IsType<BoundExpressionStatement>(result.Statements[i]);
            var faExpr = Assert.IsType<BoundFieldAccessExpression>(es.Expression);
            Assert.Same(tempDecl.Variable, ((BoundVariableExpression)faExpr.Receiver).Variable);
            Assert.Same(field, faExpr.Field);
        }
    }

    [Fact]
    public void RefLocal_BareUseWithSideEffectingOperand_HoistsAtDeclarationSite()
    {
        // ref int x = ref Arr()[i];  PassByRef(x); PassByRef(x);
        // The bare use must produce `&temp[i]` not `&Arr()[i]` repeated.
        var arrFactory = typeof(System.Array).GetMethod(nameof(System.Array.Empty))!.MakeGenericMethod(typeof(int));
        var arrCall = new BoundClrStaticCallExpression(
            null,
            arrFactory,
            TypeSymbol.FromClrType(typeof(int[])),
            ImmutableArray<BoundExpression>.Empty);

        var i = new LocalVariableSymbol("i", isReadOnly: false, TypeSymbol.Int32);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var indexExpr = new BoundIndexExpression(null, arrCall, new BoundVariableExpression(null, i), TypeSymbol.Int32);
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, indexExpr));

        var bareUse1 = new BoundExpressionStatement(null, new BoundVariableExpression(null, slot));
        var bareUse2 = new BoundExpressionStatement(null, new BoundVariableExpression(null, slot));

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declSlot, bareUse1, bareUse2));
        var result = RefInitializationHoister.Rewrite(body);

        // Prelude: one temp (for arrCall). `i` is a trivially repeatable BoundVariableExpression.
        var prelude = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        Assert.Single(prelude.Statements);
        var tempDecl = Assert.IsType<BoundVariableDeclaration>(prelude.Statements[0]);
        Assert.Same(arrCall, tempDecl.Initializer);

        // Each bare use should be &temp[i].
        for (int k = 1; k <= 2; k++)
        {
            var es = Assert.IsType<BoundExpressionStatement>(result.Statements[k]);
            var addr = Assert.IsType<BoundAddressOfExpression>(es.Expression);
            var idx = Assert.IsType<BoundIndexExpression>(addr.Operand);
            Assert.Same(tempDecl.Variable, ((BoundVariableExpression)idx.Target).Variable);
            Assert.Same(i, ((BoundVariableExpression)idx.Index).Variable);
        }
    }

    [Fact]
    public void BareRefLocalUsage_ReplacedWithAddressOf()
    {
        // If a ref local is used without dereference (e.g., passed to a ref param),
        // it should be replaced with &operand.
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var declX = new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 10));
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, new BoundVariableExpression(null, x)));

        // Bare usage of slot (not dereferenced)
        var bareUse = new BoundExpressionStatement(null, new BoundVariableExpression(null, slot));

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declX, declSlot, bareUse));

        var result = RefInitializationHoister.Rewrite(body);
        var stmts = result.Statements;

        // Statement 2: expression should be &x (BoundAddressOfExpression)
        Assert.IsType<BoundExpressionStatement>(stmts[2]);
        var expr = ((BoundExpressionStatement)stmts[2]).Expression;
        Assert.IsType<BoundAddressOfExpression>(expr);
        var addrOf = (BoundAddressOfExpression)expr;
        Assert.IsType<BoundVariableExpression>(addrOf.Operand);
        Assert.Equal("x", ((BoundVariableExpression)addrOf.Operand).Variable.Name);
    }
}
