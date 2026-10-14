// <copyright file="ObjectInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #522: parser tests for the C#-style object-initializer suffix
/// (`T(args) { Prop = value, … }`). Confirms that the new grammar is
/// recognised in expression positions without regressing the existing
/// body-header parsers (if/for/while/switch braces remain statement bodies).
open class ObjectInitializerParserTests {
    @Fact
    func Parses_EmptyInitializerList() {
        const source = `package P
func Main() {
  var w = WithInit() { }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Parses_SinglePropertyInitializer() {
        const source = `package P
func Main() {
  var w = WithInit() { Asin = "X" }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Parses_MultiplePropertyInitializers() {
        const source = `package P
func Main() {
  var w = WithInit() { Asin = "X", Title = "T" }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Parses_TrailingComma() {
        // Trailing comma is allowed for consistency with argument lists,
        // tuple literals, struct literals, and array initializers.
        const source = `package P
func Main() {
  var w = WithInit() { Asin = "X", Title = "T", }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Parses_NestedObjectInitializer() {
        const source = `package P
func Main() {
  var w = Outer() { Inner = Inner() { X = 1 } }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Parses_WithIntegerProperty() {
        const source = `package P
func Main() {
  var w = Box() { Value = 1 }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func DoesNotEat_IfStatementBody() {
        // The body-header suppression flag keeps `if Cond() { … }` parsing as
        // a regular `if` with a body block, even though the body's first
        // statement is `Identifier = expr` (the shape that would otherwise
        // be mis-eaten as an object initializer).
        const source = `package P
func Main() {
  var x = 0
  if Cond() {
    x = 1
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func DoesNotEat_ForRangeStatementBody() {
        const source = `package P
func Main() {
  var total = 0
  for v in Items() {
    total = total + v
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func DoesNotEat_ForConditionStatementBody() {
        const source = `package P
func Main() {
  var x = 0
  for Cond() {
    x = x + 1
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func DoesNotEat_SwitchStatementBody() {
        const source = `package P
func Main() {
  var x = 0
  switch Cond() {
  default {
    x = 1
  }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func AllowsObjectInitializer_InsideArgumentInBodyHeader() {
        // Even though `if Cond() { … }` suppresses the trailing initializer
        // at the body-header level, the inner call argument is a fresh
        // expression context that re-allows initializers.
        const source = `package P
func Main() {
  if Process(Build() { X = 1 }) {
    Noop()
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func AllowsObjectInitializer_InsideParensInBodyHeader() {
        const source = `package P
func Main() {
  if (Build() { X = 1 }) != nil {
    Noop()
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ProducesObjectCreationExpression_NodeKind() {
        const source = `package P
func Main() {
  var w = WithInit() { Asin = "X" }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let objectCreation ObjectCreationExpressionSyntax? = FindFirst[ObjectCreationExpressionSyntax](tree.Root)
        Assert.NotNull(objectCreation)
        Assert.Equal(SyntaxKind.ObjectCreationExpression, objectCreation!!.Kind)
        let init = objectCreation!!.Initializers.Single()
        Assert.Equal("Asin", init.PropertyIdentifier.Text)
        Assert.Equal(SyntaxKind.EqualsToken, init.EqualsToken.Kind)
    }

    shared {
        private func FindFirst[T SyntaxNode](root SyntaxNode) T? {
            if root is T match {
                return match
            }
            for child in root.GetChildren() {
                let found T? = FindFirst[T](child)
                if found != nil {
                    return found
                }
            }
            return nil
        }
    }
}
