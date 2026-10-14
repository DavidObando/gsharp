// <copyright file="Issue3095SpillSequenceSpillerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import Xunit

/// Verifies that await spilling preserves call-site emission metadata.
class Issue3095SpillSequenceSpillerTests {
    @Fact
    func ImportedStaticCall_PreservesGenericArgumentsAndContainer() {
        let method = typeof(Enumerable)
            .GetMethods()
            .Single((candidate MethodInfo) -> candidate.Name == "ToList" && candidate.GetParameters().Length == 1)
            .MakeGenericMethod(typeof(object))
        let function = ImportedFunctionSymbol(method.Name, ImportedClassSymbol(typeof(Enumerable), nil), method, nil)
        let typeArguments = ImmutableArray.Create[TypeSymbol](TypeSymbol.String)
        let staticContainerType = TypeSymbol.Object
        let call = BoundImportedCallExpression(
            nil,
            function,
            ImmutableArray.Create[BoundExpression](
                BoundAwaitExpression(
                    nil,
                    BoundLiteralExpression(nil, 0),
                    TypeSymbol.FromClrType(typeof(IEnumerable[object]))
                )
            ),
            typeArgumentSymbols: typeArguments,
            staticContainerType: staticContainerType
        )
        let rewritten BoundExpression? = RewriteInitializer(call)
        let rewrittenCall = Assert.IsType[BoundImportedCallExpression](rewritten)
        AssertImmutableArrayEqual(typeArguments, rewrittenCall.TypeArgumentSymbols)
        Assert.Same(staticContainerType, rewrittenCall.StaticContainerType)
    }

    @Fact
    func ImportedInstanceCall_PreservesGenericAndDispatchMetadata() {
        let method = typeof(List[object]).GetMethod("ConvertAll")!!.MakeGenericMethod(typeof(object))
        let typeArguments = ImmutableArray.Create[TypeSymbol](TypeSymbol.String)
        let constrainedReceiver = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let constrainedInterface = ImportedTypeSymbol.Get(typeof(IComparable[object]))
        let receiver = BoundVariableExpression(
            nil,
            LocalVariableSymbol("items", isReadOnly: true, TypeSymbol.FromClrType(typeof(List[object])))
        )
        let call = BoundImportedInstanceCallExpression(
            nil,
            receiver,
            method,
            TypeSymbol.FromClrType(typeof(List[object])),
            ImmutableArray.Create[BoundExpression](
                BoundAwaitExpression(
                    nil,
                    BoundLiteralExpression(nil, 0),
                    TypeSymbol.FromClrType(typeof(Converter[object, object]))
                )
            ),
            typeArgumentSymbols: typeArguments,
            constrainedReceiverTypeParameter: constrainedReceiver,
            constrainedInterfaceType: constrainedInterface,
            isNonVirtualBaseCall: true
        )
        let rewritten BoundExpression? = RewriteInitializer(call)
        let rewrittenCall = Assert.IsType[BoundImportedInstanceCallExpression](rewritten)
        AssertImmutableArrayEqual(typeArguments, rewrittenCall.TypeArgumentSymbols)
        Assert.Same(constrainedReceiver, rewrittenCall.ConstrainedReceiverTypeParameter)
        Assert.Same(constrainedInterface, rewrittenCall.ConstrainedInterfaceType)
        Assert.True(rewrittenCall.IsNonVirtualBaseCall)
    }

    @Fact
    func UserInstanceCall_PreservesGenericAndDispatchMetadata() {
        let methodTypeParameter = TypeParameterSymbol(
            "TMethod",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
        let method = FunctionSymbol(
            "Convert",
            ImmutableArray.Create(ParameterSymbol("value", TypeSymbol.Int32)),
            TypeSymbol.String,
            declaration: nil,
            $package: nil,
            Accessibility.Public,
            receiverType: TypeSymbol.Object
        ){TypeParameters = ImmutableArray.Create(methodTypeParameter)}
        let methodTypeArguments = ImmutableArray.Create[TypeSymbol](TypeSymbol.String)
        let constrainedReceiver = TypeParameterSymbol(
            "TReceiver",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
        let constrainedInterface = TypeSymbol.Object
        let receiver = BoundVariableExpression(
            nil,
            LocalVariableSymbol("receiver", isReadOnly: true, TypeSymbol.Object)
        )
        let call = BoundUserInstanceCallExpression(
            nil,
            receiver,
            method,
            ImmutableArray.Create[BoundExpression](
                BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
            ),
            TypeSymbol.String,
            constrainedReceiver,
            constrainedInterface
        ){MethodTypeArguments = methodTypeArguments}
        let rewritten BoundExpression? = RewriteInitializer(call)
        let rewrittenCall = Assert.IsType[BoundUserInstanceCallExpression](rewritten)
        AssertImmutableArrayEqual(methodTypeArguments, rewrittenCall.MethodTypeArguments)
        Assert.Same(constrainedReceiver, rewrittenCall.ConstrainedReceiverTypeParameter)
        Assert.Same(constrainedInterface, rewrittenCall.ConstrainedInterfaceType)
    }

    shared {
        private func RewriteInitializer(initializer BoundExpression) BoundExpression? {
            let result = LocalVariableSymbol("result", isReadOnly: true, initializer.Type)
            let body = BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(nil, result, initializer))
            )
            let rewritten = SpillSequenceSpiller.Rewrite(body)
            return Assert.IsType[BoundVariableDeclaration](rewritten.Statements[^1]).Initializer
        }

        private func AssertImmutableArrayEqual[T](expected ImmutableArray[T], actual ImmutableArray[T]) {
            Assert.Equal(expected.IsDefault, actual.IsDefault)
            if !expected.IsDefault {
                Assert.Equal(expected.ToArray(), actual.ToArray())
            }
        }
    }
}
