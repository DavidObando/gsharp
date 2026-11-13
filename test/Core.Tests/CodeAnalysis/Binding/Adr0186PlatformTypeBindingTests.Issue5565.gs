package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import Xunit

partial class Adr0186PlatformTypeBindingTests {
    @Theory
    @InlineData("Ob.Value()", "string!")
    @InlineData("Ob.NilNestField", "Adr0186.Step2.Library.Nested!")
    @InlineData("Ob.Strings()", "System.Collections.Generic.List[string!]!")
    func Issue5565_LiteralNilFallback_PreservesTheInferredPlatformType(expression string, expected string) {
        using let world = World()
        let original = world.GlobalProbeType("let probe = " + expression, NullabilityMode.PlatformTypes)
        Assert.Equal(ReferenceNullabilityKind.Platform, original.ReferenceNullability)
        let op = BoundBinaryOperator.Bind(SyntaxKind.QuestionQuestionToken, original, TypeSymbol.Null)
        Assert.NotNull(op)
        Assert.Same(original, op!!.Type)
        let inferred = world.GlobalProbeType(
            "let original = " + expression + "\nlet probe = original ?? nil",
            NullabilityMode.PlatformTypes
        )
        Assert.Equal(ReferenceNullabilityKind.Platform, inferred.ReferenceNullability)
        Assert.Equal(expected, world.LastProbeDisplay)
    }
}
