// <copyright file="RefInitializationHoisterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Linq
import Xunit

open class RefInitializationHoisterTests {
    @Fact
    func RefLocal_NotCrossingAwait_LeftAlone() {
        // A body with no await: the hoister still eliminates ref locals
        // (conservative V1 approach for async bodies), but let's verify that
        // the non-ref parts are untouched.
        let x = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let y = LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.Int32)
        // var x = 42
        // var y = x + 1
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 42)),
                BoundVariableDeclaration(
                    nil,
                    y,
                    BoundBinaryExpression(
                        nil,
                        BoundVariableExpression(nil, x),
                        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32)!!,
                        BoundLiteralExpression(nil, 1)
                    )
                )
            )
        )
        let result = RefInitializationHoister.Rewrite(body)
        // No ref locals → body unchanged (same reference).
        Assert.Same(body, result)
    }

    @Fact
    func RefLocal_To_Local_CrossingAwait_RewritesUseToAddressOfHoistedLocal() {
        // var x = 10
        // var slot = &x   (ref local: type *int, initializer is BoundAddressOfExpression)
        // ... (imagine await here) ...
        // *slot            (dereference → should become just `x`)
        let x = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let slot = LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32))
        let declX = BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 10))
        let declSlot = BoundVariableDeclaration(
            nil,
            slot,
            BoundAddressOfExpression(nil, BoundVariableExpression(nil, x))
        )
        // Use: *slot (dereference)
        let deref = BoundDereferenceExpression(nil, BoundVariableExpression(nil, slot))
        let useStmt = BoundExpressionStatement(nil, deref)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](declX, declSlot, useStmt))
        let result = RefInitializationHoister.Rewrite(body)
        // The ref local declaration should be removed (replaced with empty block).
        Assert.NotSame(body, result)
        let stmts = result.Statements
        // Statement 0: var x = 10 (unchanged)
        Assert.IsType[BoundVariableDeclaration](stmts[0])
        let declXResult = cast[BoundVariableDeclaration](stmts[0])
        Assert.Equal("x", declXResult.Variable.Name)
        // Statement 1: empty block (ref local decl removed)
        Assert.IsType[BoundBlockStatement](stmts[1])
        Assert.Empty((cast[BoundBlockStatement](stmts[1])).Statements)
        // Statement 2: expression statement with the inlined operand (x, not *slot)
        Assert.IsType[BoundExpressionStatement](stmts[2])
        let expr = (cast[BoundExpressionStatement](stmts[2])).Expression
        Assert.IsType[BoundVariableExpression](expr)
        Assert.Equal("x", (cast[BoundVariableExpression](expr)).Variable.Name)
    }

    @Fact
    func RefLocal_To_ArrayElement_CrossingAwait_HoistsArrayAndIndex() {
        // var arr = [array]
        // var i = 2
        // var slot = &arr[i]  (ref local, initializer = BoundAddressOfExpression(BoundIndexExpression(arr, i)))
        // *slot               (should become arr[i])
        let arr = LocalVariableSymbol("arr", isReadOnly: false, TypeSymbol.FromClrType(typeof([]int32)))
        let i = LocalVariableSymbol("i", isReadOnly: false, TypeSymbol.Int32)
        let slot = LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32))
        let indexExpr = BoundIndexExpression(
            nil,
            BoundVariableExpression(nil, arr),
            BoundVariableExpression(nil, i),
            TypeSymbol.Int32
        )
        let declSlot = BoundVariableDeclaration(nil, slot, BoundAddressOfExpression(nil, indexExpr))
        let deref = BoundDereferenceExpression(nil, BoundVariableExpression(nil, slot))
        let useStmt = BoundExpressionStatement(nil, deref)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](declSlot, useStmt))
        let result = RefInitializationHoister.Rewrite(body)
        let stmts = result.Statements
        // Statement 0: empty block (ref local decl removed)
        Assert.IsType[BoundBlockStatement](stmts[0])
        // Statement 1: expression is arr[i] (BoundIndexExpression)
        Assert.IsType[BoundExpressionStatement](stmts[1])
        let expr = (cast[BoundExpressionStatement](stmts[1])).Expression
        Assert.IsType[BoundIndexExpression](expr)
        let idx = cast[BoundIndexExpression](expr)
        Assert.IsType[BoundVariableExpression](idx.Target)
        Assert.Equal("arr", (cast[BoundVariableExpression](idx.Target)).Variable.Name)
        Assert.IsType[BoundVariableExpression](idx.Index)
        Assert.Equal("i", (cast[BoundVariableExpression](idx.Index)).Variable.Name)
    }

    @Fact
    func RefLocal_To_FieldAccess_CrossingAwait_HoistsReceiver() {
        // var slot = &obj.field  (ref local)
        // *slot                  (should become obj.field)
        let field = FieldSymbol("value", TypeSymbol.Int32, Accessibility.Public)
        let structType = StructSymbol("MyStruct", ImmutableArray.Create(field), Accessibility.Public, nil, "test")
        let obj = LocalVariableSymbol("obj", isReadOnly: false, structType)
        let slot = LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32))
        let fieldAccess = BoundFieldAccessExpression(nil, BoundVariableExpression(nil, obj), structType, field)
        let declSlot = BoundVariableDeclaration(nil, slot, BoundAddressOfExpression(nil, fieldAccess))
        let deref = BoundDereferenceExpression(nil, BoundVariableExpression(nil, slot))
        let useStmt = BoundExpressionStatement(nil, deref)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](declSlot, useStmt))
        let result = RefInitializationHoister.Rewrite(body)
        let stmts = result.Statements
        // Statement 1: expression is obj.field (BoundFieldAccessExpression)
        Assert.IsType[BoundExpressionStatement](stmts[1])
        let expr = (cast[BoundExpressionStatement](stmts[1])).Expression
        Assert.IsType[BoundFieldAccessExpression](expr)
        let fa = cast[BoundFieldAccessExpression](expr)
        Assert.Equal("value", fa.Field.Name)
    }

    @Fact
    func NonAsync_Function_NotProcessed() {
        // When body is null, Rewrite returns null.
        let result = RefInitializationHoister.Rewrite(nil)
        Assert.Null(result)
    }

    @Fact
    func RefLocal_To_ArrayElement_WithSideEffectingTarget_HoistsTargetOnce() {
        // Issue #418 / P1-12: `ref int x = ref Arr()[Idx()]; *x = 1; *x = 2;`
        // The old hoister inlined the operand at every use, evaluating Arr()
        // and Idx() once per use. The fix hoists each side-effecting subpart
        // into a single temp local at the ref-init site so every use re-derives
        // the lvalue from the same evaluated state.
        let idxMethod = typeof(Array).GetMethod(
            "GetLength"
        )!!// any MethodInfo will do — we just need something non-trivial as `target`/`index`.
        let arrType = TypeSymbol.FromClrType(typeof([]int32))
        // Use BoundClrStaticCall to fabricate Arr() and Idx().
        let arrCallType = arrType
        let idxCallType = TypeSymbol.Int32
        // Reuse a real static method whose signature happens to match: we only
        // care about reference equality through the rewriter; runtime semantics
        // aren't exercised by the unit test. System.Array.Empty<int>() returns int[].
        let arrFactoryMethod = typeof(Array).GetMethod("Empty")!!.MakeGenericMethod(typeof(int32))
        // System.Environment.TickCount is an int property — too awkward. Use Math.Abs(int) as Idx().
        let idxFactoryMethod = typeof(Math).GetMethod("Abs", []Type{typeof(int32)})!!
        let arrCall = BoundClrStaticCallExpression(
            nil,
            arrFactoryMethod,
            arrCallType,
            ImmutableArray[BoundExpression].Empty
        )
        let idxCall = BoundClrStaticCallExpression(
            nil,
            idxFactoryMethod,
            idxCallType,
            ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, 3))
        )
        let slot = LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32))
        let indexExpr = BoundIndexExpression(nil, arrCall, idxCall, TypeSymbol.Int32)
        let declSlot = BoundVariableDeclaration(nil, slot, BoundAddressOfExpression(nil, indexExpr))
        // Two uses of *slot — the original bug would have evaluated arrCall and
        // idxCall twice.
        let use1 = BoundExpressionStatement(nil, BoundDereferenceExpression(nil, BoundVariableExpression(nil, slot)))
        let use2 = BoundExpressionStatement(nil, BoundDereferenceExpression(nil, BoundVariableExpression(nil, slot)))
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](declSlot, use1, use2))
        let result = RefInitializationHoister.Rewrite(body)
        let stmts = result.Statements
        // Statement 0: two component temps, then an address probe preserving
        // pre-await bounds/null exceptions.
        let prelude = Assert.IsType[BoundBlockStatement](stmts[0])
        Assert.Equal(3, prelude.Statements.Length)
        let t0Decl = Assert.IsType[BoundVariableDeclaration](prelude.Statements[0])
        let t1Decl = Assert.IsType[BoundVariableDeclaration](prelude.Statements[1])
        Assert.Same(arrCall, t0Decl.Initializer)
        Assert.Same(idxCall, t1Decl.Initializer)
        let probe = Assert.IsType[BoundExpressionStatement](prelude.Statements[2])
        Assert.IsType[BoundAddressOfExpression](probe.Expression)
        // Statements 1 and 2: each use is `temp0[temp1]` — same temp symbols, not the original calls.
        let ReadUse = func (s BoundStatement) BoundIndexExpression {
            let es = Assert.IsType[BoundExpressionStatement](s)
            return Assert.IsType[BoundIndexExpression](es.Expression)
        }
        let idx1 = ReadUse(stmts[1])
        let idx2 = ReadUse(stmts[2])
        Assert.Same(t0Decl.Variable, (cast[BoundVariableExpression](idx1.Target)).Variable)
        Assert.Same(t1Decl.Variable, (cast[BoundVariableExpression](idx1.Index)).Variable)
        Assert.Same(t0Decl.Variable, (cast[BoundVariableExpression](idx2.Target)).Variable)
        Assert.Same(t1Decl.Variable, (cast[BoundVariableExpression](idx2.Index)).Variable)
        // Crucially: the call expressions appear EXACTLY ONCE across the whole
        // rewritten body — in the prelude. Repeated references would indicate
        // the side-effect-duplication bug.
        let CountSubtreeRefs = func (needle BoundExpression, haystack BoundStatement) int32 {
            var count = 0
            let Visit = func (n object?) {
                if n == nil {
                    return
                }
                if object.ReferenceEquals(n, needle) {
                    count++
                    return
                }
                switch n {
                    case b is BoundBlockStatement {
                        for s in b.Statements {
                            Visit(s)
                        }
                    }
                    case vd is BoundVariableDeclaration {
                        Visit(vd.Initializer)
                    }
                    case es is BoundExpressionStatement {
                        Visit(es.Expression)
                    }
                    case ix is BoundIndexExpression {
                        Visit(ix.Target)
                        Visit(ix.Index)
                    }
                    case ao is BoundAddressOfExpression {
                        Visit(ao.Operand)
                    }
                    case de is BoundDereferenceExpression {
                        Visit(de.Operand)
                    }
                }
            }
            Visit(haystack)
            return count
        }
        Assert.Equal(1, CountSubtreeRefs(arrCall, result))
        Assert.Equal(1, CountSubtreeRefs(idxCall, result))
    }

    @Fact
    func RefLocal_To_FieldAccess_WithSideEffectingReceiver_HoistsReceiverOnce() {
        // ref int x = ref GetObj().field; *x = 1; *x = 2;
        // The receiver call must be evaluated exactly once.
        let field = FieldSymbol("value", TypeSymbol.Int32, Accessibility.Public)
        let structType = StructSymbol("MyStruct", ImmutableArray.Create(field), Accessibility.Public, nil, "test")
        // Synthesize a side-effecting "GetObj()" via a static CLR call. The runtime
        // type doesn't have to match — the rewriter is purely syntactic.
        let dummyMethod = typeof(Math).GetMethod("Abs", []Type{typeof(int32)})!!
        let receiverCall = BoundClrStaticCallExpression(
            nil,
            dummyMethod,
            structType,
            ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, 0))
        )
        let slot = LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32))
        let fa = BoundFieldAccessExpression(nil, receiverCall, structType, field)
        let declSlot = BoundVariableDeclaration(nil, slot, BoundAddressOfExpression(nil, fa))
        let use1 = BoundExpressionStatement(nil, BoundDereferenceExpression(nil, BoundVariableExpression(nil, slot)))
        let use2 = BoundExpressionStatement(nil, BoundDereferenceExpression(nil, BoundVariableExpression(nil, slot)))
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](declSlot, use1, use2))
        let result = RefInitializationHoister.Rewrite(body)
        // Prelude: receiver temp followed by the original address probe.
        let prelude = Assert.IsType[BoundBlockStatement](result.Statements[0])
        Assert.Equal(2, prelude.Statements.Length)
        let tempDecl = Assert.IsType[BoundVariableDeclaration](prelude.Statements[0])
        Assert.Same(receiverCall, tempDecl.Initializer)
        let probe = Assert.IsType[BoundExpressionStatement](prelude.Statements[1])
        Assert.IsType[BoundAddressOfExpression](probe.Expression)
        // Each use reads `temp.value` — same temp, never the original call.
        for var i = 1; i <= 2; i++ {
            let es = Assert.IsType[BoundExpressionStatement](result.Statements[i])
            let faExpr = Assert.IsType[BoundFieldAccessExpression](es.Expression)
            Assert.Same(tempDecl.Variable, (cast[BoundVariableExpression](faExpr.Receiver)).Variable)
            Assert.Same(field, faExpr.Field)
        }
    }

    @Fact
    func RefLocal_BareUseWithSideEffectingOperand_HoistsAtDeclarationSite() {
        // ref int x = ref Arr()[i];  PassByRef(x); PassByRef(x);
        // The bare use must produce `&temp[i]` not `&Arr()[i]` repeated.
        let arrFactory = typeof(Array).GetMethod("Empty")!!.MakeGenericMethod(typeof(int32))
        let arrCall = BoundClrStaticCallExpression(
            nil,
            arrFactory,
            TypeSymbol.FromClrType(typeof([]int32)),
            ImmutableArray[BoundExpression].Empty
        )
        let i = LocalVariableSymbol("i", isReadOnly: false, TypeSymbol.Int32)
        let slot = LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32))
        let indexExpr = BoundIndexExpression(nil, arrCall, BoundVariableExpression(nil, i), TypeSymbol.Int32)
        let declSlot = BoundVariableDeclaration(nil, slot, BoundAddressOfExpression(nil, indexExpr))
        let bareUse1 = BoundExpressionStatement(nil, BoundVariableExpression(nil, slot))
        let bareUse2 = BoundExpressionStatement(nil, BoundVariableExpression(nil, slot))
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](declSlot, bareUse1, bareUse2))
        let result = RefInitializationHoister.Rewrite(body)
        // Prelude: one receiver temp plus the original address probe. `i` is a
        // trivially repeatable BoundVariableExpression.
        let prelude = Assert.IsType[BoundBlockStatement](result.Statements[0])
        Assert.Equal(2, prelude.Statements.Length)
        let tempDecl = Assert.IsType[BoundVariableDeclaration](prelude.Statements[0])
        Assert.Same(arrCall, tempDecl.Initializer)
        let probe = Assert.IsType[BoundExpressionStatement](prelude.Statements[1])
        Assert.IsType[BoundAddressOfExpression](probe.Expression)
        // Each bare use should be &temp[i].
        for var k = 1; k <= 2; k++ {
            let es = Assert.IsType[BoundExpressionStatement](result.Statements[k])
            let addr = Assert.IsType[BoundAddressOfExpression](es.Expression)
            let idx = Assert.IsType[BoundIndexExpression](addr.Operand)
            Assert.Same(tempDecl.Variable, (cast[BoundVariableExpression](idx.Target)).Variable)
            Assert.Same(i, (cast[BoundVariableExpression](idx.Index)).Variable)
        }
    }

    @Fact
    func BareRefLocalUsage_ReplacedWithAddressOf() {
        // If a ref local is used without dereference (e.g., passed to a ref param),
        // it should be replaced with &operand.
        let x = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let slot = LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32))
        let declX = BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 10))
        let declSlot = BoundVariableDeclaration(
            nil,
            slot,
            BoundAddressOfExpression(nil, BoundVariableExpression(nil, x))
        )
        // Bare usage of slot (not dereferenced)
        let bareUse = BoundExpressionStatement(nil, BoundVariableExpression(nil, slot))
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](declX, declSlot, bareUse))
        let result = RefInitializationHoister.Rewrite(body)
        let stmts = result.Statements
        // Statement 2: expression should be &x (BoundAddressOfExpression)
        Assert.IsType[BoundExpressionStatement](stmts[2])
        let expr = (cast[BoundExpressionStatement](stmts[2])).Expression
        Assert.IsType[BoundAddressOfExpression](expr)
        let addrOf = cast[BoundAddressOfExpression](expr)
        Assert.IsType[BoundVariableExpression](addrOf.Operand)
        Assert.Equal("x", (cast[BoundVariableExpression](addrOf.Operand)).Variable.Name)
    }
}
