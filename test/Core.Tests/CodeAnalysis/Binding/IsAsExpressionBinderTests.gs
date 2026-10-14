// <copyright file="IsAsExpressionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Unit tests for the binder's handling of expression-level `is` and `as` operators (issue #575).
open class IsAsExpressionBinderTests {
    @Fact
    func BoundIsExpression_HasBoolType() {
        let expr = BoundIsExpression(nil, BoundLiteralExpression(nil, "hello"), TypeSymbol.String)
        Assert.Equal(BoundNodeKind.IsExpression, expr.Kind)
        Assert.Same(TypeSymbol.Bool, expr.Type)
    }

    @Fact
    func BoundAsExpression_RefType_HasTargetType() {
        let targetType = TypeSymbol.String
        let expr = BoundAsExpression(nil, BoundLiteralExpression(nil, "hello"), targetType)
        Assert.Equal(BoundNodeKind.AsExpression, expr.Kind)
        Assert.Same(targetType, expr.Type)
    }

    @Fact
    func BoundAsExpression_NullableValueType_HasNullableType() {
        let nullableInt = NullableTypeSymbol.Get(TypeSymbol.Int32)
        let expr = BoundAsExpression(nil, BoundLiteralExpression(nil, 42), nullableInt)
        Assert.Equal(BoundNodeKind.AsExpression, expr.Kind)
        Assert.Same(nullableInt, expr.Type)
    }

    @Fact
    func BindAsExpression_NonNullableValueType_ProducesDiagnostic() {
        let source = "let boxed object = 42\nlet r = boxed as int32"
        let result = Evaluate(source)
        Assert.True(
            result.Diagnostics.Any((d Diagnostic) -> d.Id == "GS0270"),
            "Expected GS0270, got: ${string.Join(", ", result.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))}"
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
